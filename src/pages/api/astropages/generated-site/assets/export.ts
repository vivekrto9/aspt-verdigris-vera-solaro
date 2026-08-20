import type { APIRoute } from "astro";

import { buildAssetSnapshot } from "../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.export";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Project asset snapshot is ready.",
      data: await buildAssetSnapshot({ env: auth.env, templateKey: "aspt-verdigris-vera-solaro" }),
    });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset export failed.", 500);
  }
};
