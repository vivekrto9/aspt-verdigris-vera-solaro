import handler from "@astrojs/cloudflare/entrypoints/server";
import { maybeHandleAnalyticsMcpToolCall } from "./server/aggregator/analytics-mcp.ts";
import { maybeHandleUsersDataMcpToolCall } from "./server/aggregator/users-data-mcp.ts";
import { maybeHandleProjectAssetRequest } from "./server/generated-site/project-assets.ts";
import { maybeHandleProjectAssetsMcp } from "./server/generated-site/project-assets-mcp.ts";
import { maybeHandleEmailTemplatesMcp } from "./server/generated-site/email-templates-mcp.ts";
import { expireStaleVeraBookings } from "./server/vera/bookings.ts";
import { completeElapsedVeraBookings } from "./server/vera/calendly.ts";
import {
  dispatchDueCampaigns,
  dispatchDueFollowUps,
  processEmailOutbox,
} from "./server/vera/email.ts";
import type { VeraEnv } from "./server/vera/types.ts";

export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";

const fetchWithAstroPagesExtensions: typeof handler.fetch = async (request, env, context) => {
  const url = new URL(request.url);
  if (url.pathname === "/_emdash/admin" || url.pathname.startsWith("/_emdash/admin/")) {
    return Response.redirect(new URL("/", url), 302);
  }

  const projectAssetResponse = await maybeHandleProjectAssetRequest(request, env);
  if (projectAssetResponse) return projectAssetResponse;
  const projectAssetMcpResponse = await maybeHandleProjectAssetsMcp(
    request,
    env,
    async () =>
      await maybeHandleEmailTemplatesMcp(
        request,
        env,
        () => handler.fetch(request, env, context),
      ) ?? handler.fetch(request, env, context),
  );
  if (projectAssetMcpResponse) return projectAssetMcpResponse;
  const emailTemplateMcpResponse = await maybeHandleEmailTemplatesMcp(
    request,
    env,
    () => handler.fetch(request, env, context),
  );
  if (emailTemplateMcpResponse) return emailTemplateMcpResponse;
  const analyticsMcpResponse = await maybeHandleAnalyticsMcpToolCall(request, env);
  if (analyticsMcpResponse) {
    return analyticsMcpResponse;
  }
  const usersDataMcpResponse = await maybeHandleUsersDataMcpToolCall(request, env);
  if (usersDataMcpResponse) {
    return usersDataMcpResponse;
  }

  return handler.fetch(request, env, context);
};

type VeraQueueBatch = {
  messages: Array<unknown>;
  ackAll?: () => void;
  retryAll?: () => void;
};

type VeraExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

const consumeEmailQueue = async (batch: VeraQueueBatch, env: VeraEnv) => {
  try {
    const result = await processEmailOutbox({
      env,
      limit: Math.max(1, Math.min(50, batch.messages.length || 10)),
    });
    if (!result.ok) {
      batch.retryAll?.();
      return;
    }
    batch.ackAll?.();
  } catch (error) {
    console.error("Vera email Queue delivery failed.", error);
    batch.retryAll?.();
  }
};

const cleanupExpiredVeraRateLimits = async (env: VeraEnv) => {
  if (!env.DB) return;
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
  try {
    await env.DB.prepare("DELETE FROM ap_vera_rate_limits WHERE datetime(updated_at) < datetime(?)")
      .bind(cutoff)
      .run?.();
  } catch (error) {
    console.error("Vera rate-limit cleanup failed.", {
      message: error instanceof Error ? error.message : "Unknown cleanup error",
    });
  }
};

const runScheduledMaintenance = async (env: VeraEnv) => {
  await expireStaleVeraBookings(env);
  await cleanupExpiredVeraRateLimits(env);
  const lifecycle = await completeElapsedVeraBookings(env);
  if (!lifecycle.ok) throw new Error(lifecycle.message);
  await dispatchDueCampaigns({ env });
  await dispatchDueFollowUps({ env });
  const result = await processEmailOutbox({ env, limit: 50 });
  if (!result.ok) {
    throw new Error(`Vera email outbox is not ready: ${result.missingSecretNames.join(", ")}`);
  }
};

export default {
  fetch: fetchWithAstroPagesExtensions,
  queue(batch: VeraQueueBatch, env: VeraEnv, context: VeraExecutionContext) {
    context.waitUntil(consumeEmailQueue(batch, env));
  },
  scheduled(_event: unknown, env: VeraEnv, context: VeraExecutionContext) {
    context.waitUntil(
      runScheduledMaintenance(env).catch((error) => {
        console.error("Vera scheduled maintenance failed.", error);
      }),
    );
  },
};
