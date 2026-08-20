import type { APIRoute } from "astro";
import { restoreAsset } from "../../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.restore";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    const payload = await context.request.json().catch(() => ({})) as Record<string, unknown>;
    return jsonResponse({ status: "ready", state: "ready", feature, message: "Project asset restored.", data: await restoreAsset({
      env: auth.env,
      assetId: String(context.params.assetId ?? ""),
      actorType: payload.actorType === "agent" || payload.actorType === "system" || payload.actorType === "unknown" ? payload.actorType : "user",
      actorId: typeof payload.actorId === "string" ? payload.actorId : null,
    }) });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset restore failed.", 400);
  }
};
