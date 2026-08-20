import type { APIRoute } from "astro";

import {
  importContentReleaseSnapshot,
  readContentReleaseStatus,
  type ContentReleaseSnapshot,
} from "../../../../../server/generated-site/content-release.ts";
import {
  readJsonBody,
  requirePost,
} from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { requireContentReleaseServiceAuth } from "./auth.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.content-release.import";

const isSnapshot = (value: unknown): value is ContentReleaseSnapshot =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
  (value as { templateKey?: unknown }).templateKey === "aspt-verdigris-vera-solaro" &&
  Array.isArray((value as { entries?: unknown }).entries) &&
  typeof (value as { snapshotHash?: unknown }).snapshotHash === "string";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;

  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;

  const snapshot = parsed.body.snapshot ?? parsed.body;
  if (!isSnapshot(snapshot)) {
    return errorResponse(feature, "Content release import requires a valid Vera Solaro snapshot.", 400);
  }

  try {
    await importContentReleaseSnapshot({
      env: auth.env,
      snapshot,
    });
    const status = await readContentReleaseStatus({
      env: auth.env,
    });
    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Content release snapshot imported.",
      data: status,
    });
  } catch (error) {
    return errorResponse(
      feature,
      error instanceof Error ? error.message : "Content release import failed.",
      500,
    );
  }
};
