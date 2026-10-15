/**
 * Assert inventory job resolve/dedupe/stale-removal for Shopify sync.
 * Run: npx tsx apps/core/src/services/channelInventoryJobs.selfcheck.ts
 */
import {
  dedupeInventoryJobs,
  isDesignPlaceholderJob,
  resolveChannelInventoryJobs,
  staleVariantMappingsToRemove,
} from "./channelInventoryJobs";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  assert(isDesignPlaceholderJob("AB-1", "AB-1"), "placeholder match");
  assert(isDesignPlaceholderJob("ab 1", "AB1"), "placeholder ignores spaces/case");
  assert(!isDesignPlaceholderJob("AB-1", "JOB-9"), "live job is not placeholder");

  const deduped = dedupeInventoryJobs([
    { job_no: "JOB-1", totamt: "100" },
    { job_no: "job-1", totamt: "200" },
    { job_no: "JOB-2", totamt: "300" },
    { job_no: "  ", totamt: "0" },
  ]);
  assert(deduped.length === 2, "dedupe first-wins by job_no");
  assert(deduped[0]?.totamt === "100", "first duplicate wins");
  assert(deduped[1]?.job_no === "JOB-2", "second distinct job kept");

  const live = resolveChannelInventoryJobs("RING-1", [
    { job_no: "RING-1", totamt: "1" },
    { job_no: "27650-2", totamt: "3950" },
    { job_no: "27650-2", totamt: "9999" },
  ]);
  assert(!live.outOfStock, "live stock is not OOS");
  assert(live.jobs.length === 1, "drops design_no placeholder + duplicate job");
  assert(String(live.jobs[0]?.job_no) === "27650-2", "keeps live job");
  assert(live.jobs[0]?.totamt === "3950", "first live duplicate wins");

  const oos = resolveChannelInventoryJobs("RING-1", [], 42);
  assert(oos.outOfStock, "empty feed is OOS");
  assert(oos.jobs.length === 1 && oos.jobs[0]?.job_no === "RING-1", "OOS placeholder");

  const remove = staleVariantMappingsToRemove({
    designNo: "RING-1",
    desiredJobNos: ["27650-2"],
    mapped: [
      { jobNo: "RING-1", externalVariantId: "gid://shopify/ProductVariant/1" },
      { jobNo: "27650-2", externalVariantId: "gid://shopify/ProductVariant/2" },
      { jobNo: "OLD-SOLD", externalVariantId: "gid://shopify/ProductVariant/3" },
    ],
  });
  assert(remove.length === 2, "removes placeholder + sold job");
  assert(
    remove.some((r) => r.jobNo === "RING-1") &&
      remove.some((r) => r.jobNo === "OLD-SOLD"),
    "expected stale job nos",
  );

  const keepPlaceholder = staleVariantMappingsToRemove({
    designNo: "RING-1",
    desiredJobNos: ["RING-1"],
    mapped: [
      { jobNo: "RING-1", externalVariantId: "gid://shopify/ProductVariant/1" },
    ],
  });
  assert(keepPlaceholder.length === 0, "keep OOS placeholder when that is desired");

  console.log("channelInventoryJobs.selfcheck OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
