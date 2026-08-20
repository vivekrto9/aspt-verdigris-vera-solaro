import type { APIContext } from "astro";

import { verifyRuntimeConfigSyncJwt } from "../../../../../server/aggregator/admin-sso.ts";
import { safeString } from "../../../../../server/aggregator/runtime.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";
import { errorResponse } from "../../../../../server/generated-site/responses.ts";

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
};

const getCloudflareWorkersEnv = async () => {
  try {
    const cloudflareWorkers = await import("cloudflare:workers");
    return cloudflareWorkers.env as Record<string, unknown>;
  } catch {
    return {};
  }
};

const getContentReleaseAuthEnv = async (context: APIContext) => {
  const runtimeEnv = await getRuntimeEnv(context);
  const cloudflareEnv = await getCloudflareWorkersEnv();
  return {
    ...runtimeEnv,
    ...cloudflareEnv,
  };
};

export const requireContentReleaseServiceAuth = async (
  context: APIContext,
  feature: string,
) => {
  const env = await getContentReleaseAuthEnv(context);
  const token = bearerToken(context.request);
  if (!token) {
    return {
      ok: false as const,
      env,
      response: errorResponse(feature, "Content release endpoint requires a control-plane token.", 401),
    };
  }

  const serviceToken =
    safeString(env.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN) ||
    safeString(env.SERVICE_CALLBACK_BEARER_TOKEN);
  if (serviceToken && token === serviceToken) {
    const claims = {
      iss: "astropages-control-plane" as const,
      aud: "astropages-generated-site-service" as const,
      sub: "generated-site-callback-token",
      projectId: safeString(env.ASTROPAGES_PROJECT_ID),
      environment: safeString(env.ASTROPAGES_SITE_ENVIRONMENT),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    return { ok: true as const, env, claims };
  }

  let claims;
  try {
    claims = await verifyRuntimeConfigSyncJwt(token, env.ASTROPAGES_SSO_PUBLIC_JWK);
  } catch {
    return {
      ok: false as const,
      env,
      response: errorResponse(feature, "Content release token is invalid.", 401),
    };
  }

  const expectedProjectId = safeString(env.ASTROPAGES_PROJECT_ID);
  const expectedEnvironment = safeString(env.ASTROPAGES_SITE_ENVIRONMENT);
  if (
    (expectedProjectId && claims.projectId !== expectedProjectId) ||
    (expectedEnvironment && claims.environment !== expectedEnvironment)
  ) {
    return {
      ok: false as const,
      env,
      response: errorResponse(feature, "Content release token target is invalid.", 403),
    };
  }

  return { ok: true as const, env, claims };
};
