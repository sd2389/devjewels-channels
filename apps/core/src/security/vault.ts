/**
 * Secret vault — staff paste tokens once in UI; reference as vault:<id>.
 *
 * Local (CHANNELS_VAULT_DIR or no DATABASE_URL): JSON files under .data/secrets/.
 * Production Lambda: Postgres channels.vault_secret (Lambda FS is read-only / ephemeral).
 * Never log resolved secret values.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { channelsRepoRoot, optionalServerEnv } from "../config/serverEnv";
import {
  CHANNELS_SCHEMA,
  tryGetChannelsDb,
  type SqlClient,
} from "../db/shared/client";

export function resolveVaultRoot(): string {
  const configured = optionalServerEnv("CHANNELS_VAULT_DIR");
  if (configured) return path.resolve(configured);
  return path.join(channelsRepoRoot(), ".data", "secrets");
}

function vaultRoot(): string {
  return resolveVaultRoot();
}

function assertSafeVaultId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== id) {
    throw new Error("Invalid vault secret id");
  }
  return safe;
}

function vaultPath(id: string): string {
  return path.join(vaultRoot(), `${assertSafeVaultId(id)}.json`);
}

/** File vault when CHANNELS_VAULT_DIR is set (selfchecks); else DB if configured. */
export function usesDatabaseVault(): boolean {
  if (optionalServerEnv("CHANNELS_VAULT_DIR")) return false;
  return tryGetChannelsDb() != null;
}

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err != null &&
    "code" in err &&
    (err as { code?: string }).code === "42P01"
  );
}

function isReadonlyFs(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

let vaultTableReady: Promise<void> | null = null;

async function ensureVaultTable(db: SqlClient): Promise<void> {
  if (!vaultTableReady) {
    vaultTableReady = db
      .query(
        `CREATE TABLE IF NOT EXISTS ${CHANNELS_SCHEMA}.vault_secret (
           id TEXT PRIMARY KEY,
           payload TEXT NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        vaultTableReady = null;
        throw err;
      });
  }
  await vaultTableReady;
}

async function writeDbVault(id: string, serialized: string): Promise<void> {
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("Channels database is not configured");
  }
  try {
    await ensureVaultTable(db);
    await db.query(
      `INSERT INTO ${CHANNELS_SCHEMA}.vault_secret (id, payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, updated_at = now()`,
      [id, serialized],
    );
  } catch (err) {
    console.error("vault_write_failed", {
      error_type: err instanceof Error ? err.name : "Error",
      code:
        typeof err === "object" && err != null && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "",
    });
    throw new Error("Could not save vault secret. Try again.");
  }
}

async function readDbVault(id: string): Promise<string> {
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error(`Vault secret not found: ${id}`);
  }
  try {
    const result = await db.query<{ payload: string }>(
      `SELECT payload FROM ${CHANNELS_SCHEMA}.vault_secret WHERE id = $1 LIMIT 1`,
      [id],
    );
    const payload = result.rows[0]?.payload;
    if (payload == null || payload === "") {
      throw new Error(`Vault secret not found: ${id}`);
    }
    return payload;
  } catch (err) {
    if (isUndefinedTable(err)) {
      throw new Error(`Vault secret not found: ${id}`);
    }
    throw err;
  }
}

async function writeFileVault(id: string, serialized: string): Promise<void> {
  try {
    const dir = vaultRoot();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(vaultPath(id), serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    if (isReadonlyFs(err)) {
      console.error("vault_write_failed", {
        error_type: "ReadonlyFS",
        code: (err as NodeJS.ErrnoException).code || "",
      });
      throw new Error("Could not save vault secret. Try again.");
    }
    throw err;
  }
}

async function readFileVault(id: string): Promise<string> {
  try {
    return await fs.readFile(vaultPath(id), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`Vault secret not found: ${id}`);
    }
    throw err;
  }
}

/**
 * Persist secret JSON; returns credentials_secret_ref `vault:<id>`.
 * Pass a stable `id` (e.g. shopify-oauth-app) to overwrite; default is a new UUID.
 */
export async function writeVaultSecret(
  payload: Record<string, unknown>,
  id: string = randomUUID(),
): Promise<string> {
  const safeId = assertSafeVaultId(id);
  const serialized = JSON.stringify(payload);
  if (usesDatabaseVault()) {
    await writeDbVault(safeId, serialized);
  } else {
    await writeFileVault(safeId, serialized);
  }
  return `vault:${safeId}`;
}

export async function readVaultSecret(id: string): Promise<string> {
  const safeId = assertSafeVaultId(id);
  if (usesDatabaseVault()) {
    return readDbVault(safeId);
  }
  return readFileVault(safeId);
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
