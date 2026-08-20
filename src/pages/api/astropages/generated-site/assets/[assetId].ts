import type { APIRoute } from "astro";
import { deleteAsset, updateAssetMetadata } from "../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.item";

export const PATCH: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    const payload = await context.request.json() as Record<string, unknown>;
    return jsonResponse({ status: "ready", state: "ready", feature, message: "Project asset updated.", data: await updateAssetMetadata({
      ...payload,
      env: auth.env,
      assetId: String(context.params.assetId ?? ""),
      actorType: payload.actorType === "agent" || payload.actorType === "system" || payload.actorType === "unknown" ? payload.actorType : "user",
    } as Parameters<typeof updateAssetMetadata>[0]) });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset update failed.", 400);
  }
};

export const DELETE: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    const payload = await context.request.json().catch(() => ({})) as Record<string, unknown>;
    return jsonResponse({ status: "ready", state: "ready", feature, message: "Project asset deleted.", data: await deleteAsset({
      env: auth.env,
      assetId: String(context.params.assetId ?? ""),
      actorType: payload.actorType === "agent" || payload.actorType === "system" || payload.actorType === "unknown" ? payload.actorType : "user",
      actorId: typeof payload.actorId === "string" ? payload.actorId : null,
    }) });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset deletion failed.", 400);
  }
};
