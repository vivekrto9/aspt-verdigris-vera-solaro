import type { APIRoute } from "astro";
import { revokeAdminSession } from "../../../../../server/aggregator/admin-sso.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const cookies = await revokeAdminSession(env, context.request);
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
};
