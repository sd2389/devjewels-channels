/**
 * Per-design product sync: create when entitled; delete when revoked.
 * Mapped products default to inventory qty + wholesale cost only — merchant
 * owns titles, descriptions, selling prices, variants, tags, images, status
 * unless connection.sync_product_content is opted in.
 */
import { registerDefaultAdapters } from "@/channels/registerAdapters";
import { AdapterRouter } from "@/channels/router";
import {
  InventorySkipError,
  NotImplementedError,
} from "@/channels/types";
import { getConnectionById } from "@/services/connections";
import { storeApiClient } from "@/integrations/storeApi/client";
import {
  designInFeed,
  requireSyncableEntitlements,
} from "@/services/entitlements";
import { resolveChannelVariantPrice } from "@/services/channelUnitPrice";
import { getDesignMarkup } from "@/services/connectionDesignMarkups";
import { resolveDesignImageUrls } from "@/services/designImageUrls";
import { resolveDesignShopifyTaxonomy } from "@/services/designShopifyTaxonomy";
import {
  resolveChannelInventoryJobs,
  staleVariantMappingsToRemove,
} from "@/services/channelInventoryJobs";
import { detailsFromInventoryJob } from "@/services/jobVariantDetails";
import {
  getProductMappingStore,
  upsertProductMapping,
} from "@/services/productMappings";
import { getVariantMappingStore } from "@/services/variantMappings";
import { writeSyncLog } from "@/services/syncLog";
import { enqueueInventorySync } from "@/services/queue";
import type { ProductSyncJob } from "@/workers/handlers";

export type ProductSyncOutcome =
  | "SUCCESS"
  | "SKIPPED"
  | "RETRYING"
  | "FAILED"
  | "CREATED"
  | "UPDATED"
  | "DELETED";

function parsePrice(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof InventorySkipError) return err.reason;
  if (err instanceof Error) {
    return err.message.replace(/shpat_[a-zA-Z0-9]+/g, "shpat_***").slice(0, 500);
  }
  return "unknown_error";
}

function isRateLimitError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ShopifyRateLimitError"
  );
}

async function runProductDelete(
  job: ProductSyncJob,
): Promise<ProductSyncOutcome> {
  const connection = await getConnectionById(job.connectionId);
  if (!connection) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo: job.designNo,
      message: "connection_not_found",
    });
    return "FAILED";
  }

  const designNo = String(job.designNo || "").trim();
  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(job.connectionId, designNo);
  if (!existing?.external_product_id) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo,
      message: "not_mapped",
    });
    return "SKIPPED";
  }

  // A merchant-owned product is never deleted: its page, URL, photos, reviews
  // and SEO are the merchant's work, and a revoke must not destroy them. Zeroing
  // every mapped piece takes the design off sale, which is what revoke is for,
  // and leaves the mappings so re-entitlement puts stock straight back.
  if (!connection.sync_product_content) {
    const mapped = await getVariantMappingStore().listByDesign(
      job.connectionId,
      designNo,
    );
    for (const variant of mapped) {
      await enqueueInventorySync({
        kind: "inventory.sync",
        connectionId: job.connectionId,
        platform: job.platform,
        designNo,
        jobNo: variant.job_no,
        quantity: 0,
        reason: "revoked",
      });
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SUCCESS",
      designNo,
      message: `revoked_zeroed pieces=${mapped.length} (product kept, merchant owns content)`,
    });
    return "DELETED";
  }

  const adapter = AdapterRouter.get(job.platform);
  try {
    await adapter.deleteProduct({
      connectionId: job.connectionId,
      designNo,
      externalProductId: existing.external_product_id,
      credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
    });
    await mappingStore.deleteByDesign(job.connectionId, designNo);
    await getVariantMappingStore().deleteByDesign(job.connectionId, designNo);
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SUCCESS",
      designNo,
      message: "deleted",
    });
    return "DELETED";
  } catch (err) {
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: "not_implemented",
      });
      return "SKIPPED";
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }
}

/**
 * Sync one design_no for one connection (create, update, or delete).
 */
export async function runProductSyncJob(
  job: ProductSyncJob,
): Promise<ProductSyncOutcome> {
  registerDefaultAdapters();
  if (job.connectionId === "_skeleton") {
    console.info("product_sync_skeleton_skip", { designNo: job.designNo });
    await writeSyncLog({
      connectionId: null,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "skeleton",
    });
    return "SKIPPED";
  }

  if (job.action === "delete") {
    return runProductDelete(job);
  }

  const connection = await getConnectionById(job.connectionId);
  if (!connection) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo: job.designNo,
      message: "connection_not_found",
    });
    return "FAILED";
  }

  if (!connection.is_active || !connection.sync_products) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "connection_disabled",
    });
    return "SKIPPED";
  }

  const entitlements = await requireSyncableEntitlements(connection.customer_id, {
    fresh: true,
  });
  if (!entitlements) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "no_api_key_or_permission",
    });
    return "SKIPPED";
  }

  const designNo = String(job.designNo || "").trim();
  if (!designNo) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: "",
      message: "empty_design_no",
    });
    return "SKIPPED";
  }

  if (!designInFeed(entitlements, designNo)) {
    // Not entitled → delete if mapped, else skip.
    const mapped = await getProductMappingStore().getByDesign(
      job.connectionId,
      designNo,
    );
    if (mapped) {
      return runProductDelete({ ...job, action: "delete" });
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo,
      message: "not_entitled",
    });
    return "SKIPPED";
  }

  let title = designNo;
  let defaultPrice = 0;
  let imageUrls: string[] = [];
  let productType: string | undefined;
  let tags: string[] = [];
  let category = "";
  let stoneWt = "";
  try {
    const product = await storeApiClient.getProduct(designNo, connection.customer_id!);
    title = String(product.titleline || designNo).trim() || designNo;
    defaultPrice = parsePrice(product.totamt);
    imageUrls = resolveDesignImageUrls({
      designNo,
      imageUrls: product.image_urls,
      thumbnailUrl: product.thumbnail_url,
      imageBasePath: product.image_base_path,
      defaultColor: product.default_color,
    });
    const taxonomy = resolveDesignShopifyTaxonomy({
      category: product.category,
      collection: product.collection,
      subcategory: product.subcategory,
      producttype: product.producttype,
    });
    productType = taxonomy.productType;
    tags = taxonomy.tags;
    category = String(product.category || productType || "").trim();
    stoneWt = String(product.swt ?? "").trim();
  } catch (err) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }

  const canViewInventory = entitlements.permissions.can_view_inventory;
  const canViewPrices = entitlements.permissions.can_view_prices;

  const inventory = canViewInventory
    ? await storeApiClient.getInventory(designNo)
    : { jobs: [] as Array<{ job_no?: string; totamt?: string | number }> };
  // Live jobs only; OOS → single design_no placeholder. Dedupes upstream duplicates.
  const resolved = resolveChannelInventoryJobs(
    designNo,
    canViewInventory ? inventory.jobs : [],
    defaultPrice,
  );
  const jobs = resolved.jobs;

  const designOverrideRow = await getDesignMarkup(job.connectionId, designNo);
  const designMarkup = designOverrideRow
    ? {
        markupMode: designOverrideRow.markup_mode,
        markupValue: designOverrideRow.markup_value,
      }
    : null;

  const variants = [];
  for (const j of jobs) {
    const jobNo = String(j.job_no).trim();
    // Wholesale / unit cost — never apply Channels markup (that is selling price).
    const wholesaleCost = parsePrice(j.totamt ?? defaultPrice);
    const unitPrice = await resolveChannelVariantPrice({
      customerId: connection.customer_id,
      designNo,
      jobNo,
      fallbackPrice: wholesaleCost,
      canViewPrices,
      markupMode: connection.markup_mode,
      markupValue: connection.markup_value,
      markupBps: connection.markup_bps,
      designMarkup,
    });
    variants.push({
      jobNo,
      sku: jobNo,
      price: unitPrice,
      wholesaleCost,
      quantity: canViewInventory && !resolved.outOfStock ? 1 : 0,
      details: detailsFromInventoryJob(
        j as Record<string, unknown>,
        category,
        stoneWt,
      ),
    });
  }

  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(job.connectionId, designNo);
  const variantStore = getVariantMappingStore();
  const adapter = AdapterRouter.get(job.platform);

  // Close the fetch/prepare race: queued or in-flight jobs must re-check the
  // live SoT immediately before any Shopify mutation.
  const liveEntitlements = await requireSyncableEntitlements(
    connection.customer_id,
    { fresh: true },
  );
  if (!liveEntitlements || !designInFeed(liveEntitlements, designNo)) {
    if (existing) {
      return runProductDelete({ ...job, action: "delete" });
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo,
      message: "entitlement_revoked_before_mutation",
    });
    return "SKIPPED";
  }

  try {
    let outcome: ProductSyncOutcome;
    let resultVariants: Array<{
      jobNo: string;
      externalVariantId: string;
      externalInventoryItemId?: string;
    }>;

    if (existing?.external_product_id) {
      const allMapped = await variantStore.listByDesign(
        job.connectionId,
        designNo,
      );

      const existingVariants = [];
      for (const v of variants) {
        const mapped = allMapped.find(
          (m) =>
            m.job_no.trim().toUpperCase() === v.jobNo.trim().toUpperCase(),
        );
        if (mapped) {
          existingVariants.push({
            jobNo: v.jobNo,
            externalVariantId: mapped.external_variant_id,
            externalInventoryItemId: mapped.external_inventory_item_id ?? undefined,
          });
        }
      }
      const removeVariants = staleVariantMappingsToRemove({
        designNo,
        desiredJobNos: variants.map((v) => v.jobNo),
        mapped: allMapped.map((m) => ({
          jobNo: m.job_no,
          externalVariantId: m.external_variant_id,
          externalInventoryItemId: m.external_inventory_item_id,
        })),
      });

      const updated = await adapter.updateProduct({
        connectionId: job.connectionId,
        designNo,
        title,
        syncProductContent: connection.sync_product_content,
        credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
        externalProductId: existing.external_product_id,
        imageUrls,
        productType,
        tags,
        variants,
        existingVariants,
        removeVariants,
      });

      await upsertProductMapping({
        connectionId: job.connectionId,
        designNo,
        externalProductId: updated.externalProductId,
      });
      for (const variant of updated.variants) {
        await variantStore.upsert({
          connectionId: job.connectionId,
          designNo,
          jobNo: variant.jobNo,
          externalVariantId: variant.externalVariantId,
          externalInventoryItemId: variant.externalInventoryItemId ?? null,
        });
      }
      // Keep stale variant_mapping rows for delayed Shopify order reverse-lookup.
      resultVariants = updated.variants;
      outcome = "UPDATED";
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SUCCESS",
        designNo,
        message: connection.sync_product_content
          ? `updated variants=${updated.variants.length} removed=${removeVariants.length}`
          : `live_stock_only variants=${updated.variants.length} (merchant owns content)`,
      });
    } else {
      const created = await adapter.createProduct({
        connectionId: job.connectionId,
        designNo,
        title,
        syncProductContent: connection.sync_product_content,
        credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
        imageUrls,
        productType,
        tags,
        variants,
        // Map as soon as Shopify returns a product id (shell), before variants/media.
        onExternalProductId: async (externalProductId) => {
          await upsertProductMapping({
            connectionId: job.connectionId,
            designNo,
            externalProductId,
          });
        },
      });

      await upsertProductMapping({
        connectionId: job.connectionId,
        designNo,
        externalProductId: created.externalProductId,
      });
      for (const variant of created.variants) {
        await variantStore.upsert({
          connectionId: job.connectionId,
          designNo,
          jobNo: variant.jobNo,
          externalVariantId: variant.externalVariantId,
          externalInventoryItemId: variant.externalInventoryItemId ?? null,
        });
      }
      resultVariants = created.variants;
      outcome = "CREATED";
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SUCCESS",
        designNo,
        message: `created variants=${created.variants.length}`,
      });
    }

    // Immediately set inventory after create/update when permission allows.
    if (canViewInventory && connection.sync_inventory) {
      for (const variant of resultVariants) {
        const live = variants.find((v) => v.jobNo === variant.jobNo);
        await enqueueInventorySync({
          kind: "inventory.sync",
          connectionId: job.connectionId,
          platform: job.platform,
          designNo,
          jobNo: variant.jobNo,
          // No live job behind the variant means the piece is sold — zero it.
          quantity: live?.quantity ?? 0,
          // Wholesale cost is price data. A customer entitled to inventory but
          // not to prices must not get it written into their Shopify admin;
          // resolveChannelVariantPrice already zeroes the selling price for
          // that combination, and totamt comes off an endpoint that is not
          // customer-scoped, so the gate has to be here.
          ...(live != null && canViewPrices
            ? { unitCost: live.wholesaleCost }
            : {}),
        });
      }
    }

    return outcome;
  } catch (err) {
    if (err instanceof InventorySkipError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: err.reason,
      });
      return "SKIPPED";
    }
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: "not_implemented",
      });
      return "SKIPPED";
    }
    if (isRateLimitError(err)) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "RETRYING",
        designNo,
        message: "rate_limited",
      });
      throw err;
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }
}
