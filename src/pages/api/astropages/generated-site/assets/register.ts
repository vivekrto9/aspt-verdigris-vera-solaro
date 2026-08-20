import type { APIRoute } from "astro";
import { registerAssetRevision, type RegisterAssetRevisionInput } from "../../../../../server/generated-site/project-assets.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.project-assets.register";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  try {
    const payload = await context.request.json() as Omit<RegisterAssetRevisionInput, "env">;
    return jsonResponse({ status: "ready", state: "ready", feature, message: "Project asset revision registered.", data: await registerAssetRevision({ ...payload, env: auth.env }) });
  } catch (error) {
    return errorResponse(feature, error instanceof Error ? error.message : "Asset registration failed.", 400);
  }
};
