import type { APIRoute } from "astro";
import { requireBuilderAccess } from "../../../../../builder/auth.ts";
import {
  contentItem,
  encodeBuilderStorageData,
  ensureSourceEntryForTranslation,
  resultError,
  type EmDashRuntimeLike,
  validateBuilderChanges,
} from "../../../../../builder/content.ts";
import { bootstrapAstroPagesEmDashContent } from "../../../../../server/generated-site/emdash-bootstrap.ts";
import { setContentReleaseMutationAction } from "../../../../../server/generated-site/content-release-context.ts";
import { getRuntimeEnv, readJsonBody, requirePost } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;

const feature = "aspt-verdigris-vera-solaro.content-seo-localization.editor";

const emdashError = (result: unknown, fallback: string, status = 500) => {
  const error = resultError(result);
  return errorResponse(feature, error?.message ?? fallback, status);
};

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;

  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;

  const env = await getRuntimeEnv(context);
  const action = parsedBody.body.action === "publish" ? "publish" : "saveDraft";
  setContentReleaseMutationAction(context.locals, action);
  const auth = await requireBuilderAccess(env, context.request, {
    requireCsrf: true,
    requirePublish: action === "publish",
  });
  if (!auth.ok) return auth.response;

  const { collection, entry, locale, changes } = parsedBody.body;
  const validated = validateBuilderChanges(collection, entry, locale, changes);
  if (!validated) {
    return errorResponse(feature, "This Builder entry is not editable.", 400);
  }
  if (!validated.ok) {
    return errorResponse(feature, validated.error, 400);
  }

  if (action === "saveDraft" && !Object.keys(validated.changes).length) {
    return errorResponse(feature, "No editor changes were provided.", 400);
  }

  const emdash = context.locals.emdash as unknown as EmDashRuntimeLike | undefined;
  if (!emdash?.handleContentGet) {
    return errorResponse(feature, "EmDash runtime is not configured.", 500);
  }
  if (action === "publish" && !emdash.handleContentPublish) {
    return errorResponse(feature, "EmDash publish runtime is not configured.", 500);
  }

  const handleContentGet = emdash.handleContentGet;
  const readItem = async () =>
    contentItem(await handleContentGet(validated.collection, validated.entry, validated.locale));
  let item = await readItem();

  if (action === "publish" && Object.keys(validated.changes).length === 0) {
    if (!item) {
      return errorResponse(
        feature,
        `No saved draft exists for ${validated.collection}/${validated.entry}.`,
        404,
      );
    }

    const published = await emdash.handleContentPublish!(validated.collection, item.id);
    if (!contentItem(published)) {
      return emdashError(published, `Failed to publish ${validated.collection}/${validated.entry} in EmDash.`, 500);
    }

    return jsonResponse({
      status: "ready",
      state: "ready",
      feature,
      message: "Content published.",
      data: {
        collection: validated.collection,
        entry: validated.entry,
        locale: validated.locale,
        action,
        changedFields: [],
        subject: auth.subject,
      },
    });
  }

  if (!emdash.handleContentCreate || !emdash.handleContentUpdate) {
    return errorResponse(feature, "EmDash runtime is not configured.", 500);
  }

  if (!item) {
    try {
      await bootstrapAstroPagesEmDashContent({ env });
      item = await readItem();
    } catch {
      // If the bounded repair bootstrap fails, the explicit create below will
      // return the EmDash error that the editor can show to the user.
    }
  }

  const storageData = encodeBuilderStorageData({
    ...(!item ? { title: validated.defaults.title ?? validated.entry } : {}),
    ...validated.changes,
  });

  if (!item) {
    const source =
      validated.locale === "en"
        ? undefined
        : await ensureSourceEntryForTranslation(validated.collection, validated.entry, emdash);
    if (validated.locale !== "en" && !source) {
      return errorResponse(feature, "Could not prepare the source Builder content for this translation.", 500);
    }

    const created = await emdash.handleContentCreate(validated.collection, {
      slug: validated.entry,
      locale: validated.locale,
      translationOf: source?.id,
      status: "draft",
      data: storageData,
    });

    item = contentItem(created);
    if (!item) return emdashError(created, `Failed to create ${validated.collection}/${validated.entry} in EmDash.`, 500);
  }

  let updated = await emdash.handleContentUpdate(validated.collection, item.id, {
    data: storageData,
  }).catch(async (error) => {
    try {
      await bootstrapAstroPagesEmDashContent({ env });
      const repairedItem = await readItem();
      if (!repairedItem) throw error;
      item = repairedItem;
      return await emdash.handleContentUpdate!(validated.collection, repairedItem.id, {
        data: storageData,
      });
    } catch {
      throw error;
    }
  });
  const updatedItem = contentItem(updated);
  if (!updatedItem) return emdashError(updated, `Failed to update ${validated.collection}/${validated.entry} in EmDash.`, 500);

  if (action === "publish") {
    const published = await emdash.handleContentPublish!(validated.collection, updatedItem.id);
    if (!contentItem(published)) {
      return emdashError(published, `Failed to publish ${validated.collection}/${validated.entry} in EmDash.`, 500);
    }
  }

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    message: action === "publish" ? "Content published." : "Draft saved.",
    data: {
      collection: validated.collection,
      entry: validated.entry,
      locale: validated.locale,
      action,
      changedFields: Object.keys(validated.changes),
      subject: auth.subject,
    },
  });
};
