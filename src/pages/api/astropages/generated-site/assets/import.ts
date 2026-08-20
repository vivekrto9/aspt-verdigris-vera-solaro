import type { APIRoute } from "astro";

import {
  importAssetSnapshot,
  type AssetReleaseSnapshot,
} from "../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.import";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    const payload = await context.request.json() as { snapshot?: AssetReleaseSnapshot };
    if (!payload?.snapshot) return errorResponse(feature, "Asset snapshot is required.", 400);
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Project asset snapshot import completed.",
      data: await importAssetSnapshot({ env: auth.env, snapshot: payload.snapshot }),
    });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset import failed.", 500);
  }
};
