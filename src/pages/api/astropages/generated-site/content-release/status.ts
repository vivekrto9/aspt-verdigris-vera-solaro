import type { APIRoute } from "astro";

import { readContentReleaseStatus } from "../../../../../server/generated-site/content-release.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "./auth.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.content-release.status";

export const GET: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;

  try {
    const status = await readContentReleaseStatus({
      env: auth.env,
    });
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Content release status is ready.",
      data: status,
    });
  } catch (error) {
    return errorResponse(
      feature,
      error instanceof Error ? error.message : "Content release status failed.",
      500,
    );
  }
};
