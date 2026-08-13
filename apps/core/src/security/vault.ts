/**
 * Local vault for connection secrets — staff paste tokens once in UI;
 * we store JSON under .data/secrets/ (gitignored) and reference as vault:<id>.
 * Never log resolved secret values.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function vaultRoot(): string {
  const configured = process.env.CHANNELS_VAULT_DIR?.trim();
  if (configured) return path.resolve(configured);
  // Repo root when cwd is apps/core (Next) or monorepo root.
  return path.resolve(process.cwd(), process.cwd().endsWith("apps/core") ? "../.." : ".", ".data/secrets");
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
