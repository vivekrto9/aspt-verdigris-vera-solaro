import type { APIRoute } from "astro";
import { createAdminSsoExchangeSession } from "../../../../../server/aggregator/admin-sso.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const result = await createAdminSsoExchangeSession({
    env,
    request: context.request,
  });
  return result.response;
};
