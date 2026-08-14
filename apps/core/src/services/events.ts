/**
 * Django → Channels event envelope (snake_case contract).
 * Validated with zod at the ingest boundary.
 */
import { z } from "zod";

export const INVENTORY_UPDATED = "inventory.updated" as const;
export const CATALOG_UPDATED = "catalog.updated" as const;
export const PRICE_UPDATED = "price.updated" as const;
export const ENTITLEMENT_CHANGED = "catalog.entitlement_changed" as const;

const InventoryUpdatedDataSchema = z
  .object({
    design_no: z.string().trim().min(1).max(100),
    job_no: z.string().trim().min(1).max(100).optional(),
    sku: z.string().trim().min(1).max(100).optional(),
    old_quantity: z.number().int().nonnegative(),
    new_quantity: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.job_no && !data.sku) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "data.job_no or data.sku is required",
        path: ["job_no"],
      });
    }
  })
  .transform((data) => ({
    design_no: data.design_no.trim(),
    job_no: (data.job_no ?? data.sku ?? "").trim(),
    old_quantity: data.old_quantity,
    new_quantity: data.new_quantity,
  }));

export const InventoryUpdatedEnvelopeSchema = z.object({
  event_id: z.string().trim().min(1).max(100),
  event_type: z.literal(INVENTORY_UPDATED),
  occurred_at: z.string().datetime({ offset: true }),
  data: InventoryUpdatedDataSchema,
}).strict();

export const CatalogUpdatedEnvelopeSchema = z.object({
  event_id: z.string().trim().min(1).max(100),
  event_type: z.literal(CATALOG_UPDATED),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.object({
    design_no: z.string().trim().min(1).max(100),
    change_type: z.enum(["created", "updated"]).default("updated"),
    reason: z.string().trim().min(1).max(100).default("design_save"),
  }).strict(),
}).strict();

export const PriceUpdatedEnvelopeSchema = z.object({
  event_id: z.string().trim().min(1).max(100),
  event_type: z.literal(PRICE_UPDATED),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.object({
    design_no: z.string().trim().min(1).max(100),
    job_no: z.string().trim().min(1).max(100),
    price: z.number().nonnegative(),
    currency: z.string().trim().length(3),
  }).strict(),
}).strict();

export const EntitlementChangedEnvelopeSchema = z
  .object({
    event_id: z.string().trim().min(1).max(100),
    event_type: z.literal(ENTITLEMENT_CHANGED),
    occurred_at: z.string().datetime({ offset: true }),
    data: z
      .object({
        customer_id: z.number().int().positive(),
        action: z.enum([
          "grant",
          "revoke",
          "key_revoked",
          "permissions_changed",
        ]),
        design_nos: z
          .array(z.string().trim().min(1).max(100))
          .max(5000)
          .default([]),
      })
      .strict()
      .superRefine((data, ctx) => {
        const designAction = data.action === "grant" || data.action === "revoke";
        if (designAction && data.design_nos.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${data.action} requires at least one design_no`,
            path: ["design_nos"],
          });
        }
        if (!designAction && data.design_nos.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${data.action} does not accept design_nos`,
            path: ["design_nos"],
          });
        }
      }),
  })
  .strict();

export const ChannelsEventEnvelopeSchema = z.union([
  InventoryUpdatedEnvelopeSchema,
  CatalogUpdatedEnvelopeSchema,
  PriceUpdatedEnvelopeSchema,
  EntitlementChangedEnvelopeSchema,
]);

export type InventoryUpdatedEnvelope = z.infer<typeof InventoryUpdatedEnvelopeSchema>;
export type CatalogUpdatedEnvelope = z.infer<typeof CatalogUpdatedEnvelopeSchema>;
export type PriceUpdatedEnvelope = z.infer<typeof PriceUpdatedEnvelopeSchema>;
export type EntitlementChangedEnvelope = z.infer<
  typeof EntitlementChangedEnvelopeSchema
>;
export type ChannelsEventEnvelope = z.infer<typeof ChannelsEventEnvelopeSchema>;

/** @deprecated Use ChannelsEventEnvelope — kept for scaffold compatibility. */
export type ChannelsDomainEvent = ChannelsEventEnvelope;

export function isKnownEventType(type: unknown): type is string {
  return (
    type === INVENTORY_UPDATED ||
    type === CATALOG_UPDATED ||
    type === PRICE_UPDATED ||
    type === ENTITLEMENT_CHANGED
  );
}

export function parseEventEnvelope(body: unknown): ChannelsEventEnvelope {
  return ChannelsEventEnvelopeSchema.parse(body);
}

export function safeParseEventEnvelope(body: unknown) {
  return ChannelsEventEnvelopeSchema.safeParse(body);
}
