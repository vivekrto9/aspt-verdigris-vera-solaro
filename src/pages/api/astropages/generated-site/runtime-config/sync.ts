import type { APIRoute } from "astro";
import { verifyRuntimeConfigSyncJwt } from "../../../../../server/aggregator/admin-sso.ts";
import {
  isRuntimeConfigKey,
  isSensitiveRuntimeBindingName,
  upsertRuntimeConfigRows,
} from "../../../../../server/aggregator/runtime-config.ts";
import { safeString } from "../../../../../server/aggregator/runtime.ts";
import {
  getRuntimeEnv,
  readJsonBody,
  requirePost,
} from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.generated-site-operations.runtime-config-sync";

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
};

const configRows = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry) => ({
      key: safeString(entry.key),
      value: safeString(entry.value),
      providerKey: safeString(entry.providerKey),
      status: safeString(entry.status) === "disabled" ? "disabled" as const : "active" as const,
    }));
};

const disabledRuntimeKeys = (value: unknown) =>
  Array.isArray(value) ? value.map((entry) => safeString(entry)).filter(Boolean) : [];

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;

  const env = await getRuntimeEnv(context);
  const token = bearerToken(context.request);
  if (!token) {
    return errorResponse(feature, "Runtime config sync requires a control-plane token.", 401);
  }

  let claims;
  try {
    claims = await verifyRuntimeConfigSyncJwt(token, env.ASTROPAGES_SSO_PUBLIC_JWK);
  } catch {
    return errorResponse(feature, "Runtime config sync token is invalid.", 401);
  }

  const expectedProjectId = safeString(env.ASTROPAGES_PROJECT_ID);
  const expectedEnvironment = safeString(env.ASTROPAGES_SITE_ENVIRONMENT);
  if (
    (expectedProjectId && claims.projectId !== expectedProjectId) ||
    (expectedEnvironment && claims.environment !== expectedEnvironment)
  ) {
    return errorResponse(feature, "Runtime config sync token target is invalid.", 403);
  }

  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;

  const requestedEnvironment = safeString(parsedBody.body.environment);
  if (requestedEnvironment && requestedEnvironment !== claims.environment) {
    return errorResponse(feature, "Runtime config sync environment does not match token.", 403);
  }

  const config = configRows(parsedBody.body.config);
  const disabledKeys = disabledRuntimeKeys(parsedBody.body.disabledKeys);
  const allKeys = [...config.map((item) => item.key), ...disabledKeys];
  const sensitiveKeys = allKeys.filter((key) => isSensitiveRuntimeBindingName(key));
  if (sensitiveKeys.length > 0) {
    return errorResponse(feature, "Runtime config sync cannot accept sensitive bindings.", 400);
  }

  const unsupportedKeys = allKeys.filter((key) => !isRuntimeConfigKey(key));
  if (unsupportedKeys.length > 0) {
    return errorResponse(feature, "Runtime config sync includes unsupported keys.", 400);
  }

  await upsertRuntimeConfigRows({ env, config, disabledKeys });

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "generated-site-operations",
    message: "Runtime config was synced.",
    data: {
      environment: claims.environment,
      activeCount: config.filter((item) => item.status !== "disabled").length,
      disabledCount: disabledKeys.length + config.filter((item) => item.status === "disabled").length,
    },
  });
};
