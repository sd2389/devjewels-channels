import type { ChannelPlatform, CommerceChannel } from "./types";

/**
 * Resolves a platform adapter by connection.platform.
 * Platform packages register themselves at process boot (see registerAdapters).
 */
const adapters = new Map<ChannelPlatform, CommerceChannel>();

export function registerAdapter(adapter: CommerceChannel): void {
  adapters.set(adapter.platform, adapter);
}

export function getAdapter(platform: ChannelPlatform): CommerceChannel {
  const adapter = adapters.get(platform);
  if (!adapter) {
    throw new Error(`No CommerceChannel registered for platform=${platform}`);
  }
  return adapter;
}

/** Stub: clear + re-register known adapters (called from workers / API boot). */
export function resetAdaptersForTests(): void {
  adapters.clear();
}

export type AdapterRouter = {
  get: typeof getAdapter;
  register: typeof registerAdapter;
};

export const AdapterRouter: AdapterRouter = {
  get: getAdapter,
  register: registerAdapter,
};
