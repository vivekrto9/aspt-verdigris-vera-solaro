import type { APIRoute } from "astro";
import { requireBuilderAccess } from "../../../../../builder/auth";
import {
  getRuntimeEnv,
  readJsonBody,
  requirePost,
  type GeneratedSiteRuntimeEnv,
} from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.content-editor.mcp-token";
const systemUserEmail = "builder-mcp@astropages.local";
const systemUserName = "AstroPages Builder MCP";
const adminRole = 50;
const tokenName = "AstroPages Builder MCP";
const tokenScopes = ["content:read", "content:write", "schema:read", "schema:write", "settings:read"];

type D1StatementWithFirst = {
  bind(...values: unknown[]): D1StatementWithFirst;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type ProvisionEnv = GeneratedSiteRuntimeEnv & {
  BUILDER_MCP_TOKEN?: string;
  BUILDER_MCP_PROVISION_SECRET?: string;
};

const isSafeToken = (value: string) =>
  value.startsWith("ec_pat_") && value.length >= 24;

const timingSafeEqual = (a: string, b: string) => {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }

  return diff === 0;
};

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const hashToken = async (token: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
};

const tokenPrefix = (token: string) => token.slice(0, "ec_pat_".length + 4);

const prepare = (env: ProvisionEnv, sql: string) =>
  env.DB!.prepare(sql) as unknown as D1StatementWithFirst;

const ensureSystemUser = async (env: ProvisionEnv, now: string) => {
  const existing = await prepare(env, "SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(systemUserEmail)
    .first();

  if (
    existing &&
    typeof existing === "object" &&
    "id" in existing &&
    typeof existing.id === "string"
  ) {
    await prepare(
      env,
      "UPDATE users SET name = ?, role = ?, email_verified = 1, disabled = 0, updated_at = ? WHERE id = ?",
    )
      .bind(systemUserName, adminRole, now, existing.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await prepare(
    env,
    `INSERT INTO users
      (id, email, name, avatar_url, role, email_verified, data, disabled, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 1, NULL, 0, ?, ?)`,
  )
    .bind(id, systemUserEmail, systemUserName, adminRole, now, now)
    .run();

  return id;
};

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;

  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;

  const env = (await getRuntimeEnv(context)) as ProvisionEnv;
  if (!env.DB) {
    return errorResponse(feature, "D1 database binding is not configured.", 500);
  }

  const configuredSecret = env.BUILDER_MCP_PROVISION_SECRET;
  const configuredToken = env.BUILDER_MCP_TOKEN;
  if (!configuredSecret || !configuredToken) {
    return errorResponse(feature, "Builder MCP token provisioning is not configured.", 500);
  }

  const providedSecret =
    typeof parsedBody.body.provisionSecret === "string"
      ? parsedBody.body.provisionSecret
      : context.request.headers.get("x-builder-mcp-provision-secret") ?? "";
  const hasProvisionSecret = timingSafeEqual(providedSecret, configuredSecret);
  const auth = hasProvisionSecret
    ? undefined
    : await requireBuilderAccess(env, context.request, { requirePublish: true });
  if (auth && !auth.ok) return auth.response;

  if (!isSafeToken(configuredToken)) {
    return errorResponse(feature, "BUILDER_MCP_TOKEN must be an ec_pat_ token value.", 500);
  }

  try {
    const now = new Date().toISOString();
    const userId = await ensureSystemUser(env, now);
    const hashedToken = await hashToken(configuredToken);
    const existingToken = await prepare(
      env,
      "SELECT id FROM _emdash_api_tokens WHERE token_hash = ? OR (name = ? AND user_id = ?) LIMIT 1",
    )
      .bind(hashedToken, tokenName, userId)
      .first();
    const existingTokenId =
      existingToken &&
      typeof existingToken === "object" &&
      "id" in existingToken &&
      typeof existingToken.id === "string"
        ? existingToken.id
        : undefined;

    if (existingTokenId) {
      await prepare(
        env,
        "UPDATE _emdash_api_tokens SET name = ?, token_hash = ?, prefix = ?, user_id = ?, scopes = ?, expires_at = NULL WHERE id = ?",
      )
        .bind(tokenName, hashedToken, tokenPrefix(configuredToken), userId, JSON.stringify(tokenScopes), existingTokenId)
        .run();
    } else {
      await prepare(
        env,
        `INSERT INTO _emdash_api_tokens
          (id, name, token_hash, prefix, user_id, scopes, expires_at, last_used_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
        .bind(crypto.randomUUID(), tokenName, hashedToken, tokenPrefix(configuredToken), userId, JSON.stringify(tokenScopes), now)
        .run();
    }

    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Builder MCP token provisioned.",
      data: {
        userId,
        scopes: tokenScopes,
        tokenPrefix: tokenPrefix(configuredToken),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to provision Builder MCP token.";
    return errorResponse(feature, message, 500);
  }
};
