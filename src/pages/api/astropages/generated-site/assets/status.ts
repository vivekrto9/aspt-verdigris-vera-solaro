import type { APIRoute } from "astro";

import { readAssetStatus } from "../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.status";

export const GET: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Project asset status is ready.",
      data: await readAssetStatus(auth.env),
    });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset status failed.", 500);
  }
};
