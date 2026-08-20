export const localeStrategy = "query-param" as const;
export const defaultLocale = "en" as const;
export const rtlSupported = false;
export const maxActiveLocales = 8;

export const activeLocaleCodes = ["en"] as const;
export type SupportedLocale = (typeof activeLocaleCodes)[number];

export type LocaleDirection = "ltr" | "rtl";
export type LocaleCatalogStatus = "active" | "available";

export type LocaleCatalogEntry = {
  code: string;
  label: string;
  name: string;
  nativeName: string;
  dir: LocaleDirection;
  hreflang: string;
  status: LocaleCatalogStatus;
  fallbackChain: string[];
  translationStatus: "verified" | "draft-ready";
  qaStatus: "template-verified" | "catalog-approved";
};

export const availableLocaleCatalog = [
  {
    code: "en",
    label: "ENG",
    name: "English",
    nativeName: "English",
    dir: "ltr",
    hreflang: "en",
    status: "active",
    fallbackChain: [],
    translationStatus: "verified",
    qaStatus: "template-verified",
  },
] as const satisfies readonly LocaleCatalogEntry[];

export const activeLocales = availableLocaleCatalog.filter((locale) =>
  (activeLocaleCodes as readonly string[]).includes(locale.code),
) as Array<Extract<(typeof availableLocaleCatalog)[number], { code: SupportedLocale }>>;

export const inactiveCatalogLocales = availableLocaleCatalog.filter((locale) => locale.status !== "active");

export const publicEditableContentCollection = "multiple" as const;
export const publicEditableContentEntries = [
  "site_chrome/main",
  "site_pages/home",
  "site_pages/not_found_page",
  "vera_home_sections/main",
  "vera_readings/main",
  "vera_booking/main",
  "vera_booking_payment/main",
  "vera_writing/main",
  "vera_article/main",
  "vera_about/main",
  "vera_questions/main",
  "vera_contact/main",
  "vera_legal/main",
  "vera_letters/main",
  "vera_letters_status/main",
  "vera_account/main",
  "vera_account_room/main",
  "vera_account_schedule/main",
  "vera_account_cancel/main",
  "vera_account_receipt/main",
  "vera_closed/main",
  "vera_auth/main",
] as const;

export function isActiveLocale(locale: string | null | undefined): locale is SupportedLocale {
  return (activeLocaleCodes as readonly string[]).includes(locale ?? "");
}

export function isApprovedLocale(locale: string | null | undefined): boolean {
  return availableLocaleCatalog.some((item) => item.code === locale);
}

export function getLocaleMeta(locale: string | null | undefined): LocaleCatalogEntry | undefined {
  return availableLocaleCatalog.find((item) => item.code === locale);
}

export function getLocaleFromUrl(url: string | URL, fallback: SupportedLocale = defaultLocale): SupportedLocale {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const requested = parsed.searchParams.get("locale");
  return isActiveLocale(requested) ? requested : fallback;
}

export function localizePath(href: string, locale: SupportedLocale): string {
  if (locale === defaultLocale || href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) {
    return href;
  }
  const [pathAndQuery = "", hash = ""] = href.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const params = new URLSearchParams(query);
  params.set("locale", locale);
  const next = `${path}?${params.toString()}`;
  return hash ? `${next}#${hash}` : next;
}
