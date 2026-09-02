import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../server/generated-site/request.ts";
import { getPublicAnalyticsConfig } from "../../../../server/aggregator/integrations/analytics.ts";
export const prerender = false;
export const GET: APIRoute = async (context) => Response.json(
  await getPublicAnalyticsConfig(await getRuntimeEnv(context)), { headers: { "cache-control": "no-store" } },
);
