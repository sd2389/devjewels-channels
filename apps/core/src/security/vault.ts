/**
 * Local vault for connection secrets — staff paste tokens once in UI;
 * we store JSON under .data/secrets/ (gitignored) and reference as vault:<id>.
 * Never log resolved secret values.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { channelsRepoRoot, optionalServerEnv } from "../config/serverEnv";

export function resolveVaultRoot(): string {
  const configured = optionalServerEnv("CHANNELS_VAULT_DIR");
  if (configured) return path.resolve(configured);
  return path.join(channelsRepoRoot(), ".data", "secrets");
}

function vaultRoot(): string {
  return resolveVaultRoot();
}

function vaultPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== id) {
    throw new Error("Invalid vault secret id");
  }
  return path.join(vaultRoot(), `${safe}.json`);
}

/**
 * Persist secret JSON; returns credentials_secret_ref `vault:<id>`.
 * Pass a stable `id` (e.g. shopify-oauth-app) to overwrite; default is a new UUID.
 */
export async function writeVaultSecret(
  payload: Record<string, unknown>,
  id: string = randomUUID(),
): Promise<string> {
  const dir = vaultRoot();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = vaultPath(id);
  await fs.writeFile(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  return `vault:${id}`;
}

export async function readVaultSecret(id: string): Promise<string> {
  const file = vaultPath(id);
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`Vault secret not found: ${id}`);
    }
    throw err;
  }
}

/** Missing vault entry → null (do not throw). Other IO errors propagate. */
export async function tryReadVaultSecret(id: string): Promise<string | null> {
  try {
    return await readVaultSecret(id);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return null;
    throw err;
  }
}
