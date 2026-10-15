/**
 * Resolve Customer API / channels inventory jobs for Shopify product variants.
 *
 * Rules:
 * - One variant per canonical job_no (upstream can emit duplicates).
 * - OOS designs get a single placeholder SKU = design_no (qty 0).
 * - When live jobs exist, never keep the design_no placeholder alongside them.
 */

export type InventoryJobLike = {
  job_no?: string | null;
  totamt?: string | number | null;
  [key: string]: unknown;
};

function normJob(jobNo: string): string {
  return jobNo.trim().toUpperCase();
}

function normDesign(designNo: string): string {
  return designNo.replace(/\s+/g, "").trim().toUpperCase();
}

/** True when the mapped job is the OOS placeholder (SKU = design_no). */
export function isDesignPlaceholderJob(designNo: string, jobNo: string): boolean {
  return Boolean(designNo) && Boolean(jobNo) && normDesign(designNo) === normJob(jobNo);
}

/**
 * First-wins dedupe by job_no (case-insensitive). Empty job_no rows dropped.
 */
export function dedupeInventoryJobs<T extends InventoryJobLike>(jobs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const job of jobs) {
    const jobNo = String(job.job_no || "").trim();
    if (!jobNo) continue;
    const key = normJob(jobNo);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}

export type ResolvedChannelInventoryJobs = {
  /** Jobs to sync as Shopify variants (live or single placeholder). */
  jobs: InventoryJobLike[];
  /** True when no live stock — using design_no placeholder. */
  outOfStock: boolean;
};

/**
 * Build the variant job list for create/update.
 * Live jobs win; placeholder only when the design has zero sellable jobs.
 */
export function resolveChannelInventoryJobs(
  designNo: string,
  rawJobs: InventoryJobLike[] | null | undefined,
  defaultPrice: string | number = 0,
): ResolvedChannelInventoryJobs {
  const live = dedupeInventoryJobs(rawJobs || []).filter(
    (j) => !isDesignPlaceholderJob(designNo, String(j.job_no || "")),
  );
  if (live.length > 0) {
    return { jobs: live, outOfStock: false };
  }
  return {
    jobs: [{ job_no: designNo, totamt: defaultPrice }],
    outOfStock: true,
  };
}

/**
 * Mapped variants that must leave Shopify when the desired job set changes.
 * Always drops the design_no placeholder once real jobs exist; also drops any
 * mapped job no longer in the live desired set (sold / left warehouse).
 */
export function staleVariantMappingsToRemove(input: {
  designNo: string;
  desiredJobNos: string[];
  mapped: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string | null;
  }>;
}): Array<{
  jobNo: string;
  externalVariantId: string;
  externalInventoryItemId?: string;
}> {
  const desired = new Set(
    input.desiredJobNos.map((j) => normJob(j)).filter(Boolean),
  );
  const outOfStockOnlyPlaceholder =
    desired.size === 1 &&
    desired.has(normJob(input.designNo)) &&
    isDesignPlaceholderJob(input.designNo, input.designNo);

  const removed: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }> = [];

  for (const mapped of input.mapped) {
    const jobNo = String(mapped.jobNo || "").trim();
    if (!jobNo || !mapped.externalVariantId) continue;
    const key = normJob(jobNo);
    const isPlaceholder = isDesignPlaceholderJob(input.designNo, jobNo);

    // Keep the OOS placeholder when that is the only desired variant.
    if (outOfStockOnlyPlaceholder && isPlaceholder) continue;

    if (desired.has(key)) continue;

    removed.push({
      jobNo,
      externalVariantId: mapped.externalVariantId,
      externalInventoryItemId: mapped.externalInventoryItemId ?? undefined,
    });
  }
  return removed;
}
