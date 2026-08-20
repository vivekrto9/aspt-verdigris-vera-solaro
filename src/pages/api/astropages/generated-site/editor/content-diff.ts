import type { APIRoute } from "astro";
import { requireBuilderAccess } from "../../../../../builder/auth.ts";
import {
  buildDraftChanges,
  contentItem,
  type EmDashRuntimeLike,
} from "../../../../../builder/content.ts";
import { getBuilderEntryConfig } from "../../../../../builder/registry.ts";
import { isActiveLocale } from "../../../../../data/localization-contract.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.builder-diff";

export const GET: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const auth = await requireBuilderAccess(env, context.request);
  if (!auth.ok) return auth.response;

  const url = new URL(context.request.url);
  const collection = url.searchParams.get("collection") ?? "";
  const entry = url.searchParams.get("entry") ?? "";
  const localeParam = url.searchParams.get("locale") ?? "en";
  if (!isActiveLocale(localeParam)) {
    return errorResponse(feature, `Locale is not active for this generated site: ${localeParam}`, 400);
  }
  const locale = localeParam;
  const config = getBuilderEntryConfig(collection, entry);
  if (!config) {
    return errorResponse(feature, "This Builder entry is not editable.", 400);
  }

  const emdash = (context.locals as unknown as { emdash?: EmDashRuntimeLike }).emdash;
  if (!emdash?.handleContentGet) {
    return errorResponse(feature, "EmDash runtime is not configured.", 500);
  }

  const item = contentItem(await emdash.handleContentGet(collection, entry, locale));

  const changes = buildDraftChanges(item, config.editableFields);

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    message: changes.length > 0 ? "Draft changes found." : "No unpublished changes.",
    data: {
      collection,
      entry,
      locale,
      hasChanges: changes.length > 0,
      changes,
      subject: auth.subject,
    },
  });
};
