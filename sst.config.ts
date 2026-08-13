/// <reference path="./.sst/platform/config.d.ts" />

/**
 * DevJewels Channels — SST workspace.
 * Core owns shared queues + Next.js host; platform apps supply adapters only.
 *
 * Queues are shared across platforms (Shopify, WooCommerce, …).
 * Workers enqueue per-connection jobs; AdapterRouter picks the platform.
 *
 * Postgres (MVP): same database name as DevJewels (DB_NAME), schema `channels` only.
 * Do not provision a separate RDS/database for Channels. Wire DATABASE_URL from
 * secrets with `?options=-csearch_path%3Dchannels` (role channels_app).
 */
export default $config({
  app(input) {
    return {
      name: "devjewels-channels",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // --- Shared SQS queues (+ DLQs). Local/dev: placeholders until event-ingest wires workers. ---
    const inventoryDlq = new sst.aws.Queue("InventorySyncDlq");
    const inventorySync = new sst.aws.Queue("InventorySync", {
      dlq: inventoryDlq.arn,
    });

    // Worker: SQS → inventory sync service → AdapterRouter → Shopify updateInventory.
    inventorySync.subscribe("apps/core/src/workers/inventorySync.handler");

    const orderDlq = new sst.aws.Queue("OrderProcessingDlq");
    const orderProcessing = new sst.aws.Queue("OrderProcessing", {
      dlq: orderDlq.arn,
    });

    const productDlq = new sst.aws.Queue("ProductSyncDlq");
    const productSync = new sst.aws.Queue("ProductSync", {
      dlq: productDlq.arn,
    });

    // Worker: SQS → product sync (per-design create/update or full catalog import).
    productSync.subscribe("apps/core/src/workers/productSync.handler");

    const priceDlq = new sst.aws.Queue("PriceSyncDlq");
    const priceSync = new sst.aws.Queue("PriceSync", {
      dlq: priceDlq.arn,
    });

    const site = new sst.aws.Nextjs("ChannelsSite", {
      path: "apps/core",
      link: [inventorySync, orderProcessing, productSync, priceSync],
      environment: {
        // Same DB as DevJewels; schema only. DATABASE_URL from stage secrets/env
        // (never hardcode). Shape: …/devjewels?options=-csearch_path%3Dchannels
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        CHANNELS_SCHEMA: "channels",
        CHANNELS_SERVICE_TOKEN: process.env.CHANNELS_SERVICE_TOKEN ?? "",
        INVENTORY_SYNC_QUEUE_URL: inventorySync.url,
        ORDER_PROCESSING_QUEUE_URL: orderProcessing.url,
        PRODUCT_SYNC_QUEUE_URL: productSync.url,
        PRICE_SYNC_QUEUE_URL: priceSync.url,
        CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED:
          process.env.CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED ?? "1",
      },
    });

    return {
      url: site.url,
      queues: {
        inventorySync: inventorySync.url,
        orderProcessing: orderProcessing.url,
        productSync: productSync.url,
        priceSync: priceSync.url,
      },
    };
  },
});
