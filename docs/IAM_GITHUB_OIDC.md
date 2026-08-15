# GitHub OIDC role — least privilege for Channels SST deploy

App: `devjewels-channels` · stage: `production` · region: `us-east-2`  
Account: `293522066543`

Replace `ROLE_NAME` with your role (e.g. `devjewels-channels-github-oidc`).

## What this deploy creates / manages

| Resource | Count / notes |
|----------|----------------|
| **SST bootstrap** (once per account/region) | S3 state bucket, SSM params under `/sst/` |
| **CloudFormation** | App stack(s) for `devjewels-channels-production` |
| **SQS** | 8 queues: Inventory/Order/Product/Price + each DLQ |
| **Lambda** | 4: `…-http`, `…-inventory-sync`, `…-order-processing`, `…-product-sync` |
| **Lambda event source mappings** | 3 (SQS → workers) |
| **IAM roles/policies** | Per-Lambda execution roles (+ passrole) |
| **API Gateway HTTP API** | 1 API + `$default` route + stage + access logs |
| **API Gateway custom domain** | `channels.devjewels.com` + ACM attach (existing cert) |
| **CloudWatch Logs** | Log groups for API + Lambdas |
| **EC2 ENIs** | VPC attach (existing subnets/SGs — no new VPC) |
| **SNS** | Publish only to existing deploy topic (workflow) |

Does **not** create: VPC, NAT, RDS, ACM cert, CloudFront, ECR app images.

## Trust policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::293522066543:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:OWNER/devjewels-channels:*"
        }
      }
    }
  ]
}
```

## Permissions policy (strict-ish)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SstBootstrapS3",
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": [
        "arn:aws:s3:::sst-state-*",
        "arn:aws:s3:::sst-state-*/*",
        "arn:aws:s3:::sst-asset-*",
        "arn:aws:s3:::sst-asset-*/*"
      ]
    },
    {
      "Sid": "SstBootstrapSsm",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "ssm:DescribeParameters"
      ],
      "Resource": "arn:aws:ssm:us-east-2:293522066543:parameter/sst/*"
    },
    {
      "Sid": "CloudFormationApp",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStacks",
        "cloudformation:TagResource",
        "cloudformation:UntagResource"
      ],
      "Resource": [
        "arn:aws:cloudformation:us-east-2:293522066543:stack/devjewels-channels-*/*",
        "arn:aws:cloudformation:us-east-2:293522066543:stack/SST-*/*"
      ]
    },
    {
      "Sid": "LambdaApp",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListVersionsByFunction",
        "lambda:PublishVersion",
        "lambda:CreateAlias",
        "lambda:UpdateAlias",
        "lambda:DeleteAlias",
        "lambda:GetAlias",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:InvokeFunction",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping",
        "lambda:ListEventSourceMappings"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SqsApp",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ListQueues",
        "sqs:ListQueueTags",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:PurgeQueue",
        "sqs:AddPermission",
        "sqs:RemovePermission"
      ],
      "Resource": "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-*"
    },
    {
      "Sid": "ApiGatewayV2",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE"
      ],
      "Resource": [
        "arn:aws:apigateway:us-east-2::/apis",
        "arn:aws:apigateway:us-east-2::/apis/*",
        "arn:aws:apigateway:us-east-2::/domainnames",
        "arn:aws:apigateway:us-east-2::/domainnames/*",
        "arn:aws:apigateway:us-east-2::/tags/*"
      ]
    },
    {
      "Sid": "AcmReadExisting",
      "Effect": "Allow",
      "Action": [
        "acm:DescribeCertificate",
        "acm:GetCertificate",
        "acm:ListCertificates",
        "acm:ListTagsForCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
        "logs:ListTagsLogGroup"
      ],
      "Resource": "arn:aws:logs:us-east-2:293522066543:log-group:*"
    },
    {
      "Sid": "IamForLambdaRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": [
        "arn:aws:iam::293522066543:role/devjewels-channels-*",
        "arn:aws:iam::293522066543:role/*Channels*",
        "arn:aws:iam::293522066543:role/*Inventory*",
        "arn:aws:iam::293522066543:role/*Order*",
        "arn:aws:iam::293522066543:role/*Product*"
      ]
    },
    {
      "Sid": "IamPassLambdaService",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::293522066543:role/*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid": "VpcEniForLambda",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcs",
        "ec2:DescribeRouteTables",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SnsDeployNotify",
      "Effect": "Allow",
      "Action": ["sns:Publish"],
      "Resource": "arn:aws:sns:us-east-2:293522066543:Utilization-Alarms-topic"
    },
    {
      "Sid": "OptionalRoute53",
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets",
        "route53:GetHostedZone",
        "route53:ListHostedZones",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "*"
    }
  ]
}
```

### Notes

1. First deploy may need slightly broader CFN/S3 while SST bootstrap names settle — check Actions errors and tighten ARNs.
2. After a successful deploy, list created roles/queues in console and replace wildcards with exact ARNs.
3. Keep **AdministratorAccess** only until first green deploy, then swap to this policy.
4. Update `OWNER` in the trust policy to your GitHub org/user.
