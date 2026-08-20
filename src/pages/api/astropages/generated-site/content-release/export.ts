import type { APIRoute } from "astro";

import { buildContentReleaseSnapshot } from "../../../../../server/generated-site/content-release.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "./auth.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.content-release.export";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;

  try {
    const snapshot = await buildContentReleaseSnapshot({
      env: auth.env,
    });
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Content release snapshot exported.",
      data: snapshot,
    });
  } catch (error) {
    return errorResponse(
      feature,
      error instanceof Error ? error.message : "Content release export failed.",
      500,
    );
  }
};
