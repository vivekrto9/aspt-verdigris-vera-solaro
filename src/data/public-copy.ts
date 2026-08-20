import type { SupportedLocale } from "./localization-contract.ts";
import { chromeDefaults, homeDefaults } from "./vera/content.ts";

export type HomePageContent = Record<string, string>;

export const getHomeDefaults = (_locale: SupportedLocale = "en"): HomePageContent => ({
  ...homeDefaults,
});

export const getChromeDefaults = (_locale: SupportedLocale = "en"): HomePageContent => ({
  ...chromeDefaults,
});
