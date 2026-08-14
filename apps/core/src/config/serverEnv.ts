/**
 * Server-only env. Next inlines/allowlists `process.env.FOO` from apps/core/.env*
 * only, so repo-root `.env` is invisible in route handlers. Read the file.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let fileEnv: Record<string, string> | null = null;

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = stripQuotes(line.slice(eq + 1).trim());
  }
  return out;
}

function loadFileEnv(): Record<string, string> {
  if (fileEnv) return fileEnv;
  const merged: Record<string, string> = {};
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const name of [".env", ".env.local"]) {
      const filePath = path.join(dir, name);
      if (existsSync(filePath)) {
        Object.assign(merged, parseDotEnv(readFileSync(filePath, "utf8")));
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fileEnv = merged;
  return merged;
}

/**
 * Monorepo root (directory that contains `apps/core`). Independent of Next cwd.
 */
export function channelsRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "apps", "core"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Dynamic `process.env[name]` so Next cannot compile the key to undefined. */
export function optionalProcessEnv(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess.trim() !== "") {
    return fromProcess.trim();
  }
  return undefined;
}

/** Process env, then repo-root `.env` (Next route handlers cannot see static process.env.FOO). */
export function optionalServerEnv(name: string): string | undefined {
  const fromProcess = optionalProcessEnv(name);
  if (fromProcess) return fromProcess;
  const fromFile = loadFileEnv()[name];
  if (fromFile != null && fromFile.trim() !== "") {
    return fromFile.trim();
  }
  return undefined;
}

export function requiredServerEnv(name: string): string {
  const value = optionalServerEnv(name);
  if (value) return value;
  throw new Error(`${name} is not configured`);
}
