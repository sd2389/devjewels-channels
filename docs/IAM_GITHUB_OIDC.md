# GitHub OIDC deploy role — production policy (from live inventory)

Account: `293522066543` · Region: `us-east-2`  
App prefix: `devjewels-channels-production`

Use this on the role named in GitHub secret `AWS_ROLE_NAME` (replace AdministratorAccess).

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
          "token.actions.githubusercontent.com:sub": "repo:sd2389@183234613/devjewels-channels@1333311273:*"
        }
      }
    }
  ]
}
```

## Permissions policy

Attach as an inline or managed policy (e.g. `devjewels-channels-github-oidc-deploy`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SstStateAndAssets",
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
      "Sid": "SstBootstrapSsm",
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
      "Resource": [
        "arn:aws:ssm:us-east-2:293522066543:parameter/sst/bootstrap",
        "arn:aws:ssm:us-east-2:293522066543:parameter/sst/passphrase/*",
        "arn:aws:ssm:us-east-2:293522066543:parameter/sst/*"
      ]
    },
    {
      "Sid": "CloudFormationStacks",
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
      "Sid": "LambdaFunctions",
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
        "lambda:ListFunctions"
      ],
      "Resource": [
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-http",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-inventory-sync",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-order-processing",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-product-sync",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-production-*",
        "arn:aws:lambda:us-east-2:293522066543:function:devjewels-channels-*"
      ]
    },
    {
      "Sid": "LambdaEventSourceMappings",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping",
        "lambda:ListEventSourceMappings"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SqsQueues",
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
      "Resource": [
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-InventorySyncQueue-mwvsuehb",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-InventorySyncDlqQueue-dwteshcz",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-OrderProcessingQueue-bznfbhco",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-OrderProcessingDlqQueue-renosumb",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-ProductSyncQueue-hurncrms",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-ProductSyncDlqQueue-snonnarn",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-PriceSyncQueue-erzznazv",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-PriceSyncDlqQueue-bmaocfcx",
        "arn:aws:sqs:us-east-2:293522066543:devjewels-channels-production-*"
      ]
    },
    {
      "Sid": "ApiGatewayHttpApi",
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
        "arn:aws:apigateway:us-east-2::/apis/avohgdev4b",
        "arn:aws:apigateway:us-east-2::/apis/avohgdev4b/*",
        "arn:aws:apigateway:us-east-2::/apis/*",
        "arn:aws:apigateway:us-east-2::/domainnames",
        "arn:aws:apigateway:us-east-2::/domainnames/channels.devjewels.com",
        "arn:aws:apigateway:us-east-2::/domainnames/channels.devjewels.com/*",
        "arn:aws:apigateway:us-east-2::/domainnames/*",
        "arn:aws:apigateway:us-east-2::/tags/*"
      ]
    },
    {
      "Sid": "AcmReadExistingCert",
      "Effect": "Allow",
      "Action": [
        "acm:DescribeCertificate",
        "acm:GetCertificate",
        "acm:ListCertificates",
        "acm:ListTagsForCertificate"
      ],
      "Resource": [
        "arn:aws:acm:us-east-2:293522066543:certificate/4567d4ad-31bd-4981-8700-c4c960129db8",
        "arn:aws:acm:us-east-2:293522066543:certificate/*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
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
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/devjewels-channels-production-*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/devjewels-channels-production-*:*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/vendedlogs/apis/devjewels-channels-production-*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/vendedlogs/apis/devjewels-channels-production-*:*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/*Channels*",
        "arn:aws:logs:us-east-2:293522066543:log-group:/aws/lambda/*Channels*:*"
      ]
    },
    {
      "Sid": "IamManageLambdaExecutionRoles",
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
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::293522066543:role/devjewels-channels-production-ChannelsHttpRole-mbfdwuau",
        "arn:aws:iam::293522066543:role/devjewels-channels-production-*",
        "arn:aws:iam::293522066543:role/devjewels-channels-*",
        "arn:aws:iam::293522066543:role/*ChannelsHttp*",
        "arn:aws:iam::293522066543:role/*InventorySync*",
        "arn:aws:iam::293522066543:role/*OrderProcessing*",
        "arn:aws:iam::293522066543:role/*ProductSync*"
      ]
    },
    {
      "Sid": "IamPassRoleToLambdaOnly",
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
      "Sid": "IamListRolesForInventory",
      "Effect": "Allow",
      "Action": ["iam:ListRoles", "iam:GetRole"],
      "Resource": "*"
    },
    {
      "Sid": "VpcEniForLambdas",
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

## Live resources this maps to

| Type | Name / ID |
|------|-----------|
| Lambda | `devjewels-channels-production-http` |
| Lambda | `devjewels-channels-production-inventory-sync` |
| Lambda | `devjewels-channels-production-order-processing` |
| Lambda | `devjewels-channels-production-product-sync` |
| SQS | `…-InventorySyncQueue-mwvsuehb` (+ DLQ `…-dwteshcz`) |
| SQS | `…-OrderProcessingQueue-bznfbhco` (+ DLQ `…-renosumb`) |
| SQS | `…-ProductSyncQueue-hurncrms` (+ DLQ `…-snonnarn`) |
| SQS | `…-PriceSyncQueue-erzznazv` (+ DLQ `…-bmaocfcx`) |
| HTTP API | `avohgdev4b` (`…-ChannelsApiApi-xxafoekw`) |
| Domain | `channels.devjewels.com` |
| IAM | `…-ChannelsHttpRole-mbfdwuau` (+ subscriber roles) |
| Logs | `/aws/lambda/…-ChannelsHttpFunction-emrnhcfo`, `/aws/vendedlogs/apis/…-ChannelsApi-xtdxhktu` |
| S3 | `sst-state-vdxvusvewved`, `sst-asset-vdxvusvewved` |
| SSM | `/sst/bootstrap`, `/sst/passphrase/*` |

## Apply

1. IAM → role used by `AWS_ROLE_NAME`
2. Trust policy → paste trust JSON above (channels `@id` subject)
3. Remove `AdministratorAccess`
4. Add permissions policy JSON above
5. Re-run **Deploy Channels** once to confirm

If a deploy fails on `AccessDenied`, check the Action + Resource in the error and add only that ARN — do not re-attach admin.
