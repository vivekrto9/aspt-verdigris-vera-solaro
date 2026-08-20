import type { VeraD1Database, VeraD1Result, VeraD1Statement, VeraEnv, VeraRow } from "./types.ts";

const encoder = new TextEncoder();

export class VeraStorageError extends Error {
  status = 503;
}

export const requireVeraDb = (env: VeraEnv): VeraD1Database => {
  if (!env.DB) throw new VeraStorageError("Vera booking storage is not ready.");
  return env.DB;
};

export const first = async <T extends VeraRow = VeraRow>(
  env: VeraEnv,
  sql: string,
  values: unknown[] = [],
) => {
  const statement = requireVeraDb(env).prepare(sql).bind(...values);
  return await statement.first?.<T>() ?? null;
};

export const all = async <T extends VeraRow = VeraRow>(
  env: VeraEnv,
  sql: string,
  values: unknown[] = [],
) => {
  const statement = requireVeraDb(env).prepare(sql).bind(...values);
  return (await statement.all?.<T>())?.results ?? [];
};

export const run = async (
  env: VeraEnv,
  sql: string,
  values: unknown[] = [],
) => {
  const statement = requireVeraDb(env).prepare(sql).bind(...values);
  return await statement.run?.() as VeraD1Result | undefined;
};

export const runStatements = async (env: VeraEnv, statements: VeraD1Statement[]) => {
  const db = requireVeraDb(env);
  if (db.batch) return db.batch(statements);
  const results: unknown[] = [];
  for (const statement of statements) results.push(await statement.run?.());
  return results;
};

export const changeCount = (result: unknown) => {
  if (!result || typeof result !== "object") return 0;
  const meta = (result as { meta?: { changes?: unknown } }).meta;
  const value = Number(meta?.changes);
  return Number.isFinite(value) ? value : 0;
};

export const nowIso = (now = new Date()) => now.toISOString();

export const safeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const normalizeEmail = (value: unknown) => safeString(value).toLowerCase();

export const isValidEmail = (value: string) =>
  value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const secureId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export const randomToken = (byteLength = 24) => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const hmacSha256Hex = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const timingSafeHexEqual = (left: string, right: string) => {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right) || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

export const parseObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const fetchForEnv = (env: VeraEnv) =>
  typeof env.fetch === "function" ? env.fetch : globalThis.fetch;
