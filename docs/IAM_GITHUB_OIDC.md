# GitHub OIDC role — SST deploy (+ SNS notify)

Account: `293522066543` · Region: `us-east-2`

## Trust

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
          "token.actions.githubusercontent.com:sub": "repo:sd2389@183234613/devjewels-channels@1333311273:*"
        }
      }
    }
  ]
}
```

## Permissions (SST + SNS deploy notify)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SstS3",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:CreateBucket",
        "s3:DeleteBucket"
      ],
      "Resource": [
        "arn:aws:s3:::sst-state-vdxvusvewved",
        "arn:aws:s3:::sst-state-vdxvusvewved/*",
        "arn:aws:s3:::sst-asset-vdxvusvewved",
        "arn:aws:s3:::sst-asset-vdxvusvewved/*"
      ]
    },
    {
      "Sid": "SstSsm",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "ssm:DescribeParameters"
      ],
      "Resource": "arn:aws:ssm:us-east-2:293522066543:parameter/sst/*"
    },
    {
      "Sid": "SstCloudFormation",
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
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
        "cloudformation:ListStacks",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:TagResource",
        "cloudformation:UntagResource"
      ],
      "Resource": [
        "arn:aws:cloudformation:us-east-2:293522066543:stack/devjewels-channels-*/*",
        "arn:aws:cloudformation:us-east-2:293522066543:stack/SST-*/*"
      ]
    },
    {
      "Sid": "SstLambda",
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
        "lambda:ListTags"
      ],
      "Resource": [
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-*",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-*"
      ]
    },
    {
      "Sid": "SstLambdaEventSourceAndList",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping",
        "lambda:ListEventSourceMappings",
        "lambda:ListFunctions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SstSqs",
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
      "Resource": "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-*"
    },
    {
      "Sid": "SstApiGateway",
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
      "Sid": "SstAcmRead",
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
      "Sid": "SstLogs",
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
        "logs:ListTagsLogGroup",
        "logs:TagResource",
        "logs:UntagResource"
      ],
      "Resource": [
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/devjewels-channels-*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/devjewels-channels-*:*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/vendedlogs/apis/devjewels-channels-*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/vendedlogs/apis/devjewels-channels-*:*"
      ]
    },
    {
      "Sid": "SstIamRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
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
        "iam:ListInstanceProfilesForRole",
        "iam:ListRoleTags",
        "iam:ListRoles",
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::293522066543:role/devjewels-channels-*",
        "arn:aws:iam::293522066543:role/*Channels*",
        "arn:aws:iam::293522066543:role/*InventorySync*",
        "arn:aws:iam::293522066543:role/*OrderProcessing*",
        "arn:aws:iam::293522066543:role/*ProductSync*"
      ]
    },
    {
      "Sid": "SstPassRoleLambda",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::293522066543:role/devjewels-channels-*",
        "arn:aws:iam::293522066543:role/*Channels*",
        "arn:aws:iam::293522066543:role/*InventorySync*",
        "arn:aws:iam::293522066543:role/*OrderProcessing*",
        "arn:aws:iam::293522066543:role/*ProductSync*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "lambda.amazonaws.com"
        }
      }
    },
    {
      "Sid": "SstVpcEni",
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
        "ec2:CreateTags",
        "ec2:DescribeAccountAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SnsDeployNotify",
      "Effect": "Allow",
      "Action": ["sns:Publish"],
      "Resource": "arn:aws:sns:us-east-2:293522066543:Utilization-Alarms-topic"
    }
  ]
}
```
