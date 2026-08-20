import { getLocaleFromUrl } from "../data/localization-contract.ts";
import { getRuntimeEnv } from "../server/generated-site/request.ts";
import { createBuilder } from "./builder.ts";
import { requireBuilderAccess } from "./auth.ts";
import {
  resolveBuilderPageContent,
  type BuilderPreviewState,
  type EmDashRuntimeLike,
} from "./content.ts";
import {
  chromeTarget,
  getBuilderFieldTarget,
  getBuilderPageTargets,
  isBuilderEditableField,
  type BuilderContentTarget,
} from "./registry.ts";

type AstroLike = {
  request: Request;
  url: URL;
  locals: unknown;
};

export const getSafePublicNextPath = (url: URL, fallback = "/account") => {
  const requested = url.searchParams.get("next")?.trim();
  if (!requested || !requested.startsWith("/") || requested.startsWith("//")) return fallback;

  try {
    const destination = new URL(requested, url.origin);
    if (destination.origin !== url.origin) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
};

export const loadPublicPageContent = async (Astro: AstroLike, entry: string) => {
  const locale = getLocaleFromUrl(Astro.request.url);
  const env = await getRuntimeEnv(Astro);
  const builderAuth = await requireBuilderAccess(env, Astro.request);
  const pageTargets = getBuilderPageTargets(entry);
  const primaryTarget = pageTargets[0];
  const builder = createBuilder(Astro, { ...primaryTarget, locale }, builderAuth);
  const chromeBuilder = createBuilder(Astro, { ...chromeTarget, locale }, builderAuth);
  const targetKey = (target: BuilderContentTarget) => `${target.collection}/${target.entry}`;
  const builders = new Map(
    [...pageTargets, chromeTarget].map((target) => [
      targetKey(target),
      createBuilder(Astro, { ...target, locale }, builderAuth),
    ]),
  );
  const pageStates = await Promise.all(
    pageTargets.map((target) =>
      resolveBuilderPageContent({
        collection: target.collection,
        entry: target.entry,
        locale,
        builderEnabled: builder.studioModeEnabled,
        emdash: (Astro.locals as { emdash?: EmDashRuntimeLike } | undefined)?.emdash,
      }),
    ),
  );
  const chromePage: BuilderPreviewState = await resolveBuilderPageContent({
    collection: chromeTarget.collection,
    entry: chromeTarget.entry,
    locale,
    builderEnabled: builder.studioModeEnabled,
    emdash: (Astro.locals as { emdash?: EmDashRuntimeLike } | undefined)?.emdash,
  });
  const builderPage: BuilderPreviewState = {
    data: Object.assign({}, ...pageStates.map((state) => state.data)),
    hasSavedDraft: pageStates.some((state) => state.hasSavedDraft),
  };
  const pageContent = builderPage.data;
  const chromeContent = chromePage.data;
  const content = { ...pageContent, ...chromeContent };
  const builderEdit = (field: string) => {
    const target = getBuilderFieldTarget(field, entry);
    if (!target || !isBuilderEditableField(field, entry)) return {};
    return builders.get(targetKey(target))?.edit(field) ?? {};
  };
  const chromeEdit = (field: string) =>
    isBuilderEditableField(field, "chrome") ? chromeBuilder.edit(field) : {};
  const reviewTargets = [...pageTargets, chromeTarget].map((target) => ({
    collection: target.collection,
    entry: target.entry,
    locale,
  }));

  return {
    locale,
    builder,
    chromeBuilder,
    builderPage,
    chromePage,
    reviewTargets,
    content,
    pageContent,
    chromeContent,
    builderEdit,
    chromeEdit,
  };
};
