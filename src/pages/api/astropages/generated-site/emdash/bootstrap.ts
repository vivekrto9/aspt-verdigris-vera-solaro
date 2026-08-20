import type { APIRoute } from "astro";

import { safeString } from "../../../../../server/aggregator/runtime.ts";
import { bootstrapAstroPagesEmDashContent } from "../../../../../server/generated-site/emdash-bootstrap.ts";
import { getRuntimeEnv, requirePost } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.generated-site-emdash.bootstrap";

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
};

const getCloudflareRuntimeEnv = async () => {
  try {
    const cloudflareWorkers = await import("cloudflare:workers");
    return cloudflareWorkers.env as Record<string, unknown>;
  } catch {
    return {};
  }
};

const numericBodyValue = (
  body: Record<string, unknown>,
  key: "cursor" | "limit",
) => {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const modeBodyValue = (body: Record<string, unknown>) =>
  body.mode === "full" ? "full" : "auto";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;

  const astroEnv = await getRuntimeEnv(context);
  const cloudflareEnv = await getCloudflareRuntimeEnv();
  let env = {
    ...cloudflareEnv,
    ...astroEnv,
  };
  const token = bearerToken(context.request);
  const bootstrapSecret =
    safeString(astroEnv.BUILDER_MCP_PROVISION_SECRET) ||
    safeString(cloudflareEnv.BUILDER_MCP_PROVISION_SECRET);
  const isTemplateBootstrapSecret = Boolean(bootstrapSecret && token === bootstrapSecret);
  if (!isTemplateBootstrapSecret) {
    const auth = await requireContentReleaseServiceAuth(context, feature);
    if (!auth.ok) return auth.response;
    env = auth.env;
  }

  try {
    const body = await context.request.json().catch(() => ({}));
    const input = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const result = await bootstrapAstroPagesEmDashContent({
      env,
      cursor: numericBodyValue(input, "cursor"),
      limit: numericBodyValue(input, "limit"),
      mode: modeBodyValue(input),
    });
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Generated-site EmDash content is bootstrapped.",
      data: result,
    });
  } catch (error) {
    return errorResponse(
      feature,
      error instanceof Error ? error.message : "Generated-site EmDash bootstrap failed.",
      500,
    );
  }
};
