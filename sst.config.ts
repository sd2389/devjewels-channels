/// <reference path="./.sst/platform/config.d.ts" />

/**
 * DevJewels Channels — SST (API Gateway HTTP API + SQS workers).
 * Reuses existing VPC / SGs / subnets / ACM. No CloudFront / Next on AWS.
 *
 * Env: see `.env.example` (dedicated Channels Infisical project, path `/`, in CI).
 */
export default $config({
  app(input) {
    const prefix = (process.env.AWS_NAME_PREFIX || "devjewels-channels").trim();
    return {
      name: prefix,
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage ?? ""),
      home: "aws",
      providers: {
        aws: {
          region: process.env.AWS_REGION || "us-east-2",
        },
      },
    };
  },
  async run() {
    const stage = $app.stage;
    if (stage !== "production") {
      throw new Error(
        `[sst] Only production is supported (got "${stage}"). Use: sst deploy --stage production`,
      );
    }

    const prefix = (process.env.AWS_NAME_PREFIX || "devjewels-channels").trim();
    const name = (logical: string) => `${prefix}-production-${logical}`;

    const required = [
      "DATABASE_URL",
      "CHANNELS_SERVICE_TOKEN",
      "DEVJEWELS_API_BASE_URL",
      "AWS_SECURITY_GROUP_IDS",
    ] as const;

    for (const key of required) {
      if (!process.env[key]?.trim()) {
        throw new Error(
          `[sst] Missing ${key}. Export Infisical secrets (or local .env) before deploy.`,
        );
      }
    }
    if (
      !(process.env.AWS_SUBNET_IDS || process.env.AWS_PRIVATE_SUBNET_IDS || "").trim()
    ) {
      throw new Error(
        "[sst] Missing AWS_SUBNET_IDS (or AWS_PRIVATE_SUBNET_IDS). Export before deploy.",
      );
    }

    const sharedEnv: Record<string, string> = {
      DATABASE_URL: process.env.DATABASE_URL!,
      CHANNELS_SCHEMA: process.env.CHANNELS_SCHEMA?.trim() || "channels",
      CHANNELS_SERVICE_TOKEN: process.env.CHANNELS_SERVICE_TOKEN!,
      DEVJEWELS_API_BASE_URL: process.env.DEVJEWELS_API_BASE_URL!,
      CHANNELS_PUBLIC_BASE_URL: process.env.CHANNELS_PUBLIC_BASE_URL?.trim() || "",
      CHANNELS_OAUTH_SUCCESS_URL:
        process.env.CHANNELS_OAUTH_SUCCESS_URL?.trim() || "",
      CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED:
        process.env.CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED?.trim() || "0",
      CHANNELS_DASHBOARD_PASSWORD:
        process.env.CHANNELS_DASHBOARD_PASSWORD?.trim() || "",
      SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY?.trim() || "",
      SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET?.trim() || "",
      SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION?.trim() || "2025-01",
      SHOPIFY_SCOPES:
        process.env.SHOPIFY_SCOPES?.trim() ||
        "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders",
      SHOPIFY_OAUTH_REDIRECT_URI:
        process.env.SHOPIFY_OAUTH_REDIRECT_URI?.trim() || "",
      NODE_ENV: "production",
    };

    const securityGroups = (process.env.AWS_SECURITY_GROUP_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Prefer AWS_SUBNET_IDS; AWS_PRIVATE_SUBNET_IDS kept as alias.
    // Public-only VPCs are OK for RDS reachability; Shopify/HTTPS egress still
    // needs a NAT (Lambda ENIs never get a public IP even in public subnets).
    const subnetIds = (
      process.env.AWS_SUBNET_IDS ||
      process.env.AWS_PRIVATE_SUBNET_IDS ||
      ""
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!securityGroups.length || !subnetIds.length) {
      throw new Error(
        "[sst] production requires AWS_SECURITY_GROUP_IDS + AWS_SUBNET_IDS (existing VPC).",
      );
    }

    const vpc = { securityGroups, privateSubnets: subnetIds };

    const tags = {
      Project: "devjewels",
      Service: "channels",
      Stage: "production",
      ManagedBy: "sst",
    };

    const lambdaDefaults = {
      timeout: "60 seconds" as const,
      memory: "1024 MB" as const,
      architecture: "arm64" as const,
      environment: sharedEnv,
      ...(vpc ? { vpc } : {}),
      transform: {
        function: {
          tags,
        },
      },
    };

    // --- SQS ---
    const inventoryDlq = new sst.aws.Queue("InventorySyncDlq");
    const inventorySync = new sst.aws.Queue("InventorySync", {
      dlq: { queue: inventoryDlq.arn, retry: 5 },
      visibilityTimeout: "90 seconds",
    });

    const orderDlq = new sst.aws.Queue("OrderProcessingDlq");
    const orderProcessing = new sst.aws.Queue("OrderProcessing", {
      dlq: { queue: orderDlq.arn, retry: 5 },
      visibilityTimeout: "90 seconds",
    });

    const productDlq = new sst.aws.Queue("ProductSyncDlq");
    const productSync = new sst.aws.Queue("ProductSync", {
      dlq: { queue: productDlq.arn, retry: 5 },
      visibilityTimeout: "90 seconds",
    });

    const priceDlq = new sst.aws.Queue("PriceSyncDlq");
    const priceSync = new sst.aws.Queue("PriceSync", {
      dlq: { queue: priceDlq.arn, retry: 5 },
      visibilityTimeout: "90 seconds",
    });

    inventorySync.subscribe({
      handler: "apps/core/src/workers/inventorySync.handler",
      ...lambdaDefaults,
      link: [inventorySync, productSync],
      environment: {
        ...sharedEnv,
        PRODUCT_SYNC_QUEUE_URL: productSync.url,
      },
      transform: {
        function: {
          name: name("inventory-sync"),
          tags,
        },
      },
    });

    orderProcessing.subscribe({
      handler: "apps/core/src/workers/orderProcessing.handler",
      ...lambdaDefaults,
      link: [orderProcessing],
      transform: {
        function: {
          name: name("order-processing"),
          tags,
        },
      },
    });

    productSync.subscribe({
      handler: "apps/core/src/workers/productSync.handler",
      ...lambdaDefaults,
      link: [productSync, inventorySync],
      environment: {
        ...sharedEnv,
        INVENTORY_SYNC_QUEUE_URL: inventorySync.url,
      },
      transform: {
        function: {
          name: name("product-sync"),
          tags,
        },
      },
    });

    // --- HTTP API — existing ACM + optional Route53 ---
    const domain = (
      process.env.CHANNELS_DOMAIN ||
      process.env.CHANNELS_CUSTOM_DOMAIN ||
      ""
    ).trim();
    const acmArn = (process.env.AWS_ACM_CERTIFICATE_ARN || "").trim();
    const zoneId = (process.env.AWS_ROUTE53_ZONE_ID || "").trim();

    let domainConfig:
      | string
      | {
          name: string;
          dns?: false | ReturnType<typeof sst.aws.dns>;
          cert?: string;
        }
      | undefined;

    if (domain && acmArn) {
      domainConfig = {
        name: domain,
        cert: acmArn,
        ...(zoneId
          ? { dns: sst.aws.dns({ zone: zoneId }) }
          : { dns: false as const }),
      };
    } else if (domain && zoneId) {
      domainConfig = {
        name: domain,
        dns: sst.aws.dns({ zone: zoneId }),
      };
    } else if (domain) {
      console.warn(
        "[sst] CHANNELS_DOMAIN set without AWS_ACM_CERTIFICATE_ARN / AWS_ROUTE53_ZONE_ID — deploying without custom domain mapping.",
      );
    }

    const api = new sst.aws.ApiGatewayV2("ChannelsApi", {
      cors: {
        allowOrigins: (
          process.env.CHANNELS_CORS_ORIGINS ||
          "https://devjewels.com,http://localhost:3000"
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "X-Channels-Service-Token",
          "X-Shopify-Topic",
          "X-Shopify-Hmac-Sha256",
          "X-Shopify-Shop-Domain",
          "X-Shopify-Webhook-Id",
        ],
      },
      ...(domainConfig ? { domain: domainConfig } : {}),
    });

    const apiEnv = {
      ...sharedEnv,
      INVENTORY_SYNC_QUEUE_URL: inventorySync.url,
      ORDER_PROCESSING_QUEUE_URL: orderProcessing.url,
      PRODUCT_SYNC_QUEUE_URL: productSync.url,
      PRICE_SYNC_QUEUE_URL: priceSync.url,
    };

    const httpFn = new sst.aws.Function("ChannelsHttp", {
      handler: "apps/core/src/http/handler.handler",
      ...lambdaDefaults,
      link: [inventorySync, orderProcessing, productSync, priceSync],
      environment: apiEnv,
      transform: {
        function: {
          name: name("http"),
          tags,
        },
      },
    });

    api.route("$default", httpFn.arn);

    return {
      url: api.url,
      domain: domain || undefined,
      stage: "production",
      region: process.env.AWS_REGION || "us-east-2",
      namePrefix: prefix,
      queues: {
        inventorySync: inventorySync.url,
        orderProcessing: orderProcessing.url,
        productSync: productSync.url,
        priceSync: priceSync.url,
      },
    };
  },
});
