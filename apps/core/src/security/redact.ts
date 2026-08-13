/**
 * Redact Shopify Admin API tokens (and similar) before logs / sync_log.
 */
export function redactShopifySecrets(message: string): string {
  return message.replace(/shpat_[a-zA-Z0-9]+/g, "shpat_***").slice(0, 500);
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactShopifySecrets(err.message);
  return "unknown_error";
}
