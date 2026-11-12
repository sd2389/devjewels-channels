/**
 * Declare DevJewels piece details to Shopify so a theme can read them.
 *
 * A metafield with no definition is stored but not reliably exposed to Liquid
 * or the Storefront API, so the stock details were invisible on the storefront
 * even though every value was being written. A definition with Storefronts
 * access is Shopify's supported route, and it also surfaces the fields in the
 * merchant's admin instead of leaving them as hidden blobs.
 *
 * Never declare a unit-price metafield: Liquid can still read metafield values
 * even when storefront access is NONE. Wholesale stays on inventoryItem.cost.
 *
 * Run at connect and again at catalog import: creating a definition that is
 * already there is a no-op, so an already-connected shop heals on its next
 * import without anyone touching it.
 *
 * Product definitions are pinned. An unpinned definition sits at the bottom of
 * the product's metafields card, or behind "Show all", under every field the
 * merchant pinned — Buffed & Bubbly saw a card of their own empty fields and
 * concluded the DevJewels details were missing. Shopify caps pins per owner
 * type; at the cap the definition is kept unpinned rather than lost.
 */
import type { ShopifyAdminClient } from "./client";
import {
  DEVJEWELS_METAFIELD_NAMESPACE,
  PRODUCT_METAFIELD_FIELDS,
  PRODUCT_METAFIELD_OWNER_TYPE,
  VARIANT_METAFIELD_FIELDS,
  VARIANT_METAFIELD_OWNER_TYPE,
  VARIANT_METAFIELD_TYPE,
  type VariantMetafieldStorefrontAccess,
} from "./variantMetafieldSchema";

type DefinitionSpec = {
  ownerType: string;
  /** Result key: the variant key as-is, product keys as `product.<key>`. */
  label: string;
  key: string;
  name: string;
  storefrontAccess: VariantMetafieldStorefrontAccess;
  /** Pin into the admin card. Product only: variant pages are short already. */
  pin: boolean;
};

/**
 * Variant fields first, then the product summary. Product definitions are what
 * put the fields in the "Product metafields" card the merchant looks at; the
 * variant ones only show on each variant's own page.
 */
const DEFINITIONS: DefinitionSpec[] = [
  ...VARIANT_METAFIELD_FIELDS.map((f) => ({
    ownerType: VARIANT_METAFIELD_OWNER_TYPE,
    label: f.key,
    key: f.key,
    name: f.name,
    storefrontAccess: f.storefrontAccess,
    pin: false,
  })),
  // Prefixed: merchants keep their own product fields ("Size", "Shape", …) in
  // the same card, and two rows both called "Size" cannot be told apart.
  ...PRODUCT_METAFIELD_FIELDS.map((f) => ({
    ownerType: PRODUCT_METAFIELD_OWNER_TYPE,
    label: `product.${f.key}`,
    key: f.key,
    name: `DevJewels ${f.name}`,
    storefrontAccess: f.storefrontAccess,
    pin: true,
  })),
];

/**
 * `devjewels` is a plain namespace, not an app-reserved `$app:` one, so the
 * definitions are merchant-owned and Shopify rejects `access.admin` — only
 * `storefront` is sent (PUBLIC_READ for stock attributes).
 */
function definitionAccess(storefront: VariantMetafieldStorefrontAccess) {
  return { storefront } as const;
}

const METAFIELD_DEFINITION_CREATE = /* GraphQL */ `
  mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const METAFIELD_DEFINITION_UPDATE = /* GraphQL */ `
  mutation metafieldDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

type DefinitionUserError = {
  field?: string[] | null;
  message: string;
  code?: string | null;
};

type CreateData = {
  metafieldDefinitionCreate?: {
    createdDefinition?: { id?: string; key?: string } | null;
    userErrors?: DefinitionUserError[] | null;
  } | null;
};

type UpdateData = {
  metafieldDefinitionUpdate?: {
    updatedDefinition?: { id?: string; key?: string } | null;
    userErrors?: DefinitionUserError[] | null;
  } | null;
};

export type EnsureMetafieldDefinitionsResult = {
  created: string[];
  /** Already defined — storefront access re-asserted in case it was off. */
  existing: string[];
  /** Key → reason. Never throws: a definition is not worth failing a connect. */
  failed: Record<string, string>;
  /** Meant to be pinned, but the shop is at Shopify's pin limit (or the type cannot pin). */
  unpinned: string[];
};

function isTaken(errors: DefinitionUserError[]): boolean {
  return errors.some(
    (e) =>
      String(e.code || "").toUpperCase() === "TAKEN" ||
      /already (exists|in use)|taken/i.test(e.message),
  );
}

/** The pin was refused, not the definition: retry it unpinned. */
function isPinRefused(errors: DefinitionUserError[]): boolean {
  return errors.some((e) =>
    ["PINNED_LIMIT_REACHED", "UNSUPPORTED_PINNING"].includes(
      String(e.code || "").toUpperCase(),
    ),
  );
}

function describe(errors: DefinitionUserError[]): string {
  return errors.map((e) => e.message).join("; ").slice(0, 300);
}

/**
 * Create (or re-assert) the variant and product metafield definitions for one shop.
 *
 * Best effort by design: a shop whose token lacks write_metafield_definitions
 * still connects and still syncs stock — the details just stay invisible until
 * the scope is granted, and the returned `failed` map says so.
 */
export async function ensureShopifyMetafieldDefinitions(
  client: ShopifyAdminClient,
): Promise<EnsureMetafieldDefinitionsResult> {
  const result: EnsureMetafieldDefinitionsResult = {
    created: [],
    existing: [],
    failed: {},
    unpinned: [],
  };

  for (const field of DEFINITIONS) {
    const access = definitionAccess(field.storefrontAccess);
    let pin = field.pin;
    try {
      const create = (withPin: boolean) =>
        client.graphql<CreateData>(METAFIELD_DEFINITION_CREATE, {
          definition: {
            name: field.name,
            namespace: DEVJEWELS_METAFIELD_NAMESPACE,
            key: field.key,
            type: VARIANT_METAFIELD_TYPE,
            ownerType: field.ownerType,
            description: `DevJewels live stock — ${field.name}.`,
            access,
            ...(withPin ? { pin: true } : {}),
          },
        });
      let created = await create(pin);
      if (
        pin &&
        isPinRefused(created.data?.metafieldDefinitionCreate?.userErrors ?? [])
      ) {
        pin = false;
        created = await create(false);
      }
      if (created.errors?.length) {
        result.failed[field.label] = created.errors
          .map((e) => e.message)
          .join("; ")
          .slice(0, 300);
        continue;
      }
      const errors = created.data?.metafieldDefinitionCreate?.userErrors ?? [];
      if (!errors.length) {
        result.created.push(field.label);
        if (field.pin && !pin) result.unpinned.push(field.label);
        continue;
      }
      if (!isTaken(errors)) {
        result.failed[field.label] = describe(errors);
        continue;
      }

      // Already defined — re-assert storefront access, and the pin for a
      // product field so shops connected before pinning heal on next import.
      pin = field.pin;
      const update = (withPin: boolean) =>
        client.graphql<UpdateData>(METAFIELD_DEFINITION_UPDATE, {
          definition: {
            namespace: DEVJEWELS_METAFIELD_NAMESPACE,
            key: field.key,
            ownerType: field.ownerType,
            access,
            ...(withPin ? { pin: true } : {}),
          },
        });
      let updated = await update(pin);
      if (
        pin &&
        isPinRefused(updated.data?.metafieldDefinitionUpdate?.userErrors ?? [])
      ) {
        pin = false;
        updated = await update(false);
      }
      const updateErrors =
        updated.data?.metafieldDefinitionUpdate?.userErrors ?? [];
      if (updated.errors?.length || updateErrors.length) {
        result.failed[field.label] = updated.errors?.length
          ? updated.errors.map((e) => e.message).join("; ").slice(0, 300)
          : describe(updateErrors);
        continue;
      }
      result.existing.push(field.label);
      if (field.pin && !pin) result.unpinned.push(field.label);
    } catch (err) {
      result.failed[field.label] =
        err instanceof Error ? err.message.slice(0, 300) : "unknown_error";
    }
  }

  console.info("shopify_metafield_definitions_ensured", {
    shopDomain: client.shopDomain,
    created: result.created.length,
    existing: result.existing.length,
    failed: Object.keys(result.failed).length,
    unpinned: result.unpinned.length,
  });
  return result;
}
