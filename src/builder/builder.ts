import type { SupportedLocale } from "../data/localization-contract.ts";
import type { BuilderAccess } from "./auth.ts";

type AstroLike = {
  url: URL;
  request: Request;
};

export type BuilderTarget = {
  collection: string;
  entry: string;
  locale: SupportedLocale;
};

export type BuilderEditAttributes = {
  "data-builder-edit"?: true;
  "data-builder-collection"?: string;
  "data-builder-entry"?: string;
  "data-builder-field"?: string;
  "data-builder-locale"?: SupportedLocale;
};

export const isBuilderPreviewRequest = (astro: AstroLike): boolean =>
  astro.url.searchParams.get("preview") === "1";

export const studioModeCookieName = "astropages-content-studio";

const hasStudioModeCookie = (request: Request): boolean => {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${studioModeCookieName}=1`);
};

export const isBuilderStudioModeRequest = (astro: AstroLike): boolean =>
  isBuilderPreviewRequest(astro) || hasStudioModeCookie(astro.request);

export const createBuilder = (
  astro: AstroLike,
  target: BuilderTarget,
  auth: BuilderAccess,
) => {
  const launcherEnabled = auth.ok;
  const studioModeEnabled = launcherEnabled && isBuilderStudioModeRequest(astro);

  return {
    enabled: studioModeEnabled,
    launcherEnabled,
    studioModeEnabled,
    collection: target.collection,
    entry: target.entry,
    locale: target.locale,
    csrfToken: auth.ok ? auth.csrfToken : "",
    canPublish: auth.ok ? auth.canPublish : false,
    edit(field: string): BuilderEditAttributes {
      return studioModeEnabled
        ? {
            "data-builder-edit": true,
            "data-builder-collection": target.collection,
            "data-builder-entry": target.entry,
            "data-builder-field": field,
            "data-builder-locale": target.locale,
          }
        : {};
    },
  };
};
