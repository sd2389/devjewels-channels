/**
 * Declare DevJewels piece details to Shopify so a theme can read them.
 *
 * A metafield with no definition is stored but not reliably exposed to Liquid
 * or the Storefront API, so the stock details were invisible on the storefront
 * even though every value was being written. A definition with Storefronts
 * access is Shopify's supported route, and it also surfaces the fields in the
 * merchant's admin instead of leaving them as hidden blobs.
 *
 * Run at connect and again at catalog import: creating a definition that is
 * already there is a no-op, so an already-connected shop heals on its next
 * import without anyone touching it.
 */
import type { ShopifyAdminClient } from "./client";
import {
  DEVJEWELS_METAFIELD_NAMESPACE,
  VARIANT_METAFIELD_FIELDS,
  VARIANT_METAFIELD_OWNER_TYPE,
  VARIANT_METAFIELD_TYPE,
} from "./variantMetafieldSchema";

/**
 * Readable in a theme. `devjewels` is a plain namespace, not an app-reserved
 * `$app:` one, so the definitions are merchant-owned and Shopify rejects an
 * `access.admin` on them — storefront access is the only setting to send.
 */
const DEFINITION_ACCESS = { storefront: "PUBLIC_READ" } as const;

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
};

function isTaken(errors: DefinitionUserError[]): boolean {
  return errors.some(
    (e) =>
      String(e.code || "").toUpperCase() === "TAKEN" ||
      /already (exists|in use)|taken/i.test(e.message),
  );
}

function describe(errors: DefinitionUserError[]): string {
  return errors.map((e) => e.message).join("; ").slice(0, 300);
}

/**
 * Create (or re-assert) the variant metafield definitions for one shop.
 *
 * Best effort by design: a shop whose token lacks write_metafield_definitions
 * still connects and still syncs stock — the details just stay invisible until
 * the scope is granted, and the returned `failed` map says so.
 */
export async function ensureShopifyVariantMetafieldDefinitions(
  client: ShopifyAdminClient,
): Promise<EnsureMetafieldDefinitionsResult> {
  const result: EnsureMetafieldDefinitionsResult = {
    created: [],
    existing: [],
    failed: {},
  };

  for (const field of VARIANT_METAFIELD_FIELDS) {
    try {
      const created = await client.graphql<CreateData>(METAFIELD_DEFINITION_CREATE, {
        definition: {
          name: field.name,
          namespace: DEVJEWELS_METAFIELD_NAMESPACE,
          key: field.key,
          type: VARIANT_METAFIELD_TYPE,
          ownerType: VARIANT_METAFIELD_OWNER_TYPE,
          description: `DevJewels live stock — ${field.name}.`,
          access: DEFINITION_ACCESS,
        },
      });
      if (created.errors?.length) {
        result.failed[field.key] = created.errors
          .map((e) => e.message)
          .join("; ")
          .slice(0, 300);
        continue;
      }
      const errors = created.data?.metafieldDefinitionCreate?.userErrors ?? [];
      if (!errors.length) {
        result.created.push(field.key);
        continue;
      }
      if (!isTaken(errors)) {
        result.failed[field.key] = describe(errors);
        continue;
      }

      // Already defined — possibly without storefront access, which is the
      // whole reason the details were invisible. Re-assert it.
      const updated = await client.graphql<UpdateData>(METAFIELD_DEFINITION_UPDATE, {
        definition: {
          namespace: DEVJEWELS_METAFIELD_NAMESPACE,
          key: field.key,
          ownerType: VARIANT_METAFIELD_OWNER_TYPE,
          access: DEFINITION_ACCESS,
        },
      });
      const updateErrors =
        updated.data?.metafieldDefinitionUpdate?.userErrors ?? [];
      if (updated.errors?.length || updateErrors.length) {
        result.failed[field.key] = updated.errors?.length
          ? updated.errors.map((e) => e.message).join("; ").slice(0, 300)
          : describe(updateErrors);
        continue;
      }
      result.existing.push(field.key);
    } catch (err) {
      result.failed[field.key] =
        err instanceof Error ? err.message.slice(0, 300) : "unknown_error";
    }
  }

  console.info("shopify_metafield_definitions_ensured", {
    shopDomain: client.shopDomain,
    created: result.created.length,
    existing: result.existing.length,
    failed: Object.keys(result.failed).length,
  });
  return result;
}
