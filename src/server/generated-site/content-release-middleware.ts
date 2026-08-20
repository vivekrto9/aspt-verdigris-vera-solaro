import { defineMiddleware } from "astro:middleware";

import { contentItem, pageContentData, type EmDashRuntimeLike } from "../../builder/content.ts";
import { getBuilderEntryConfig } from "../../builder/registry.ts";
import { safeString } from "../aggregator/runtime.ts";
import {
  getContentReleaseMutationAction,
  shouldSkipLocalContentReleaseLog,
} from "./content-release-context.ts";
import { getRuntimeEnv } from "./request.ts";
import {
  fieldsChangedBetween,
  inferContentReleaseSource,
  recordContentRevision,
  sha256Hex,
} from "./content-release.ts";

type LooseEmDashRuntime = EmDashRuntimeLike & Record<string, unknown>;

const isDevelopmentRuntime = () =>
  Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const operationFor = (handler: string) => {
  if (handler === "handleContentCreate") return "create" as const;
  if (handler === "handleContentPublish") return "publish" as const;
  if (handler === "handleContentUnpublish") return "unpublish" as const;
  if (handler === "handleContentDelete") return "delete" as const;
  return "update" as const;
};

const itemData = (item: Record<string, unknown> | undefined) =>
  isRecord(item?.liveData)
    ? item.liveData
    : isRecord(item?.data)
      ? item.data
      : undefined;

const entrySlug = (
  item: Record<string, unknown> | undefined,
  fallback: unknown,
) =>
  safeString(item?.slug) ||
  safeString(item?.entry) ||
  safeString(fallback);

const localeFor = (
  item: Record<string, unknown> | undefined,
  fallback?: unknown,
) =>
  safeString(item?.locale) ||
  safeString(fallback) ||
  "en";

const shouldSkipContentReleaseLog = (request: Request) => {
  const path = new URL(request.url).pathname;
  return (
    path.includes("/api/astropages/generated-site/content-release/import") ||
    path.includes("/api/astropages/generated-site/emdash/bootstrap") ||
    request.headers.get("x-astropages-system-operation") === "bootstrap"
  );
};

const wrapMutation = (
  emdash: LooseEmDashRuntime,
  handlerName: string,
  request: Request,
  env: Awaited<ReturnType<typeof getRuntimeEnv>>,
  locals: object,
) => {
  const original = emdash[handlerName];
  if (typeof original !== "function") return;
  const url = new URL(request.url);

  (emdash as Record<string, unknown>)[handlerName] = async (...args: unknown[]) => {
    const collection = safeString(args[0]);
    const itemIdOrSlug = args[1];
    const before = handlerName === "handleContentCreate"
      ? undefined
      : contentItem(await emdash.handleContentGet?.(collection, safeString(itemIdOrSlug)));

    const result = await (original as (...handlerArgs: unknown[]) => Promise<unknown>)(...args);
    if (
      shouldSkipContentReleaseLog(request) ||
      shouldSkipLocalContentReleaseLog(request, isDevelopmentRuntime())
    ) {
      return result;
    }
    if (
      handlerName === "handleContentUpdate" &&
      url.pathname.includes("/editor/content-field") &&
      getContentReleaseMutationAction(locals) === "publish"
    ) {
      return result;
    }

    const after = contentItem(result) || contentItem(await emdash.handleContentGet?.(collection, safeString(itemIdOrSlug)));
    const entry = entrySlug(after ?? before, itemIdOrSlug);
    const locale = localeFor(after ?? before, isRecord(args[2]) ? args[2].locale : undefined);
    const config = getBuilderEntryConfig(collection, entry);
    if (!collection || !entry || !config) return result;

    const beforeData = pageContentData(itemData(before));
    const afterData = pageContentData(itemData(after));
    const changedFields = fieldsChangedBetween(beforeData, afterData, config.editableFields.map((field) => field.slug));
    if (changedFields.length === 0 && handlerName !== "handleContentPublish") return result;

    const { source, actorType, actorId } = inferContentReleaseSource(request);
    await recordContentRevision({
      env,
      source,
      actorType,
      actorId,
      operation: operationFor(String(handlerName)),
      collection,
      entry,
      locale,
      changedFields,
      contentHash: await sha256Hex({ collection, entry, locale, data: afterData }),
      metadata: {
        handler: handlerName,
        requestPath: new URL(request.url).pathname,
      },
    });

    return result;
  };
};

export const astropagesContentReleaseMiddleware = defineMiddleware(async (context, next) => {
  const emdash = context.locals.emdash as unknown as LooseEmDashRuntime | undefined;
  if (emdash) {
    const env = await getRuntimeEnv(context);
    for (const handler of [
      "handleContentCreate",
      "handleContentUpdate",
      "handleContentPublish",
      "handleContentUnpublish",
      "handleContentDelete",
      "handleContentDiscardDraft",
      "handleRevisionRestore",
    ]) {
      wrapMutation(emdash, handler, context.request, env, context.locals);
    }
  }

  return next();
});
