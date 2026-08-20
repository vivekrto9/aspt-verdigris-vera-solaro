import { activeLocales, defaultLocale, localizePath, type SupportedLocale } from "../../data/localization-contract.ts";

type SiteSettings = {
  brandName?: string;
  seoTitle?: string;
  seoDescription?: string;
  contactEmail?: string;
  supportPhone?: string;
  siteUrl?: string;
};

export type PublicSeoInput = {
  requestUrl: string;
  siteSettings: SiteSettings;
  locale: SupportedLocale;
  title?: string;
  description?: string;
  canonicalPath?: string;
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogImageAlt?: string;
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  jsonLd?: Array<Record<string, unknown>>;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

const absoluteUrl = (requestUrl: string, pathOrUrl: string) => {
  const base = new URL(requestUrl);
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return new URL(pathOrUrl || "/", base.origin).toString();
};

export const resolveSiteRequestUrl = (requestUrl: string, siteUrl?: string) => {
  const configured = text(siteUrl);
  if (!configured) return requestUrl;

  try {
    const request = new URL(requestUrl);
    const base = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`);
    return new URL(`${request.pathname}${request.search}`, base.origin).toString();
  } catch {
    return requestUrl;
  }
};

export const localizedAlternates = ({
  requestUrl,
  canonicalPath,
}: {
  requestUrl: string;
  canonicalPath: string;
}) => [
  ...activeLocales.map((locale) => ({
    locale: locale.code,
    href: absoluteUrl(requestUrl, localizePath(canonicalPath, locale.code)),
  })),
  {
    locale: "x-default",
    href: absoluteUrl(requestUrl, localizePath(canonicalPath, defaultLocale)),
  },
];

export const buildPublicSeo = ({
  requestUrl,
  siteSettings,
  locale,
  title,
  description,
  canonicalPath,
  robots,
  ogTitle,
  ogDescription,
  ogImage,
  ogImageAlt,
  twitterCard,
  twitterTitle,
  twitterDescription,
  twitterImage,
  jsonLd = [],
}: PublicSeoInput) => {
  const seoRequestUrl = resolveSiteRequestUrl(requestUrl, siteSettings.siteUrl);
  const resolvedTitle = text(title) || text(siteSettings.seoTitle) || text(siteSettings.brandName) || "Vera Solaro";
  const resolvedDescription = text(description) || text(siteSettings.seoDescription) || "";
  const resolvedCanonicalPath = text(canonicalPath) || new URL(seoRequestUrl).pathname || "/";
  const canonicalUrl = absoluteUrl(seoRequestUrl, localizePath(resolvedCanonicalPath, locale));
  const resolvedOgImage = text(ogImage);
  const resolvedTwitterImage = text(twitterImage) || resolvedOgImage;

  return {
    title: resolvedTitle,
    description: resolvedDescription,
    canonicalUrl,
    robots: text(robots) || "index,follow",
    alternates: localizedAlternates({ requestUrl: seoRequestUrl, canonicalPath: resolvedCanonicalPath }),
    og: {
      title: text(ogTitle) || resolvedTitle,
      description: text(ogDescription) || resolvedDescription,
      ...(resolvedOgImage
        ? {
            image: absoluteUrl(seoRequestUrl, resolvedOgImage),
            imageAlt: text(ogImageAlt) || text(siteSettings.brandName) || "Vera Solaro",
          }
        : {}),
    },
    twitter: {
      card: text(twitterCard) || "summary_large_image",
      title: text(twitterTitle) || text(ogTitle) || resolvedTitle,
      description: text(twitterDescription) || text(ogDescription) || resolvedDescription,
      ...(resolvedTwitterImage ? { image: absoluteUrl(seoRequestUrl, resolvedTwitterImage) } : {}),
    },
    jsonLd,
  };
};

export const buildOrganizationJsonLd = ({
  siteSettings,
  requestUrl,
}: {
  siteSettings: SiteSettings;
  requestUrl: string;
}) => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: text(siteSettings.brandName) || "Vera Solaro",
  url: new URL(resolveSiteRequestUrl(requestUrl, siteSettings.siteUrl)).origin,
  email: text(siteSettings.contactEmail) || undefined,
  telephone: text(siteSettings.supportPhone) || undefined,
});

export const buildWebSiteJsonLd = ({
  siteSettings,
  requestUrl,
}: {
  siteSettings: SiteSettings;
  requestUrl: string;
}) => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: text(siteSettings.brandName) || "Vera Solaro",
  url: new URL(resolveSiteRequestUrl(requestUrl, siteSettings.siteUrl)).origin,
});

export const buildBreadcrumbJsonLd = ({
  requestUrl,
  items,
  siteUrl,
}: {
  requestUrl: string;
  items: Array<{ name: string; path: string }>;
  siteUrl?: string;
}) => {
  const seoRequestUrl = resolveSiteRequestUrl(requestUrl, siteUrl);
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(seoRequestUrl, item.path),
    })),
  };
};

export const buildFaqJsonLd = (items: Array<{ question?: string; answer?: string }>) => {
  const questions = items.filter((item) => text(item.question) && text(item.answer));
  if (!questions.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map((item) => ({
      "@type": "Question",
      name: text(item.question),
      acceptedAnswer: {
        "@type": "Answer",
        text: text(item.answer),
      },
    })),
  };
};

export const buildArticleJsonLd = ({
  requestUrl,
  siteSettings,
  headline,
  description,
  authorName,
  datePublished,
  dateModified,
  image,
  url,
}: {
  requestUrl: string;
  siteSettings: SiteSettings;
  headline?: string;
  description?: string;
  authorName?: string;
  datePublished?: string;
  dateModified?: string;
  image?: string;
  url?: string;
}) => {
  const headlineText = text(headline);
  if (!headlineText) return null;

  const seoRequestUrl = resolveSiteRequestUrl(requestUrl, siteSettings.siteUrl);
  const publishedText = text(datePublished);
  const modifiedText = text(dateModified) || publishedText;

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: headlineText,
    ...(text(description) ? { description: text(description) } : {}),
    ...(text(authorName) ? { author: { "@type": "Person", name: text(authorName) } } : {}),
    ...(publishedText ? { datePublished: publishedText } : {}),
    ...(modifiedText ? { dateModified: modifiedText } : {}),
    ...(text(image) ? { image: absoluteUrl(seoRequestUrl, text(image)) } : {}),
    mainEntityOfPage: text(url) ? absoluteUrl(seoRequestUrl, text(url)) : new URL(seoRequestUrl).toString(),
    publisher: {
      "@type": "Organization",
      name: text(siteSettings.brandName) || "Vera Solaro",
      url: new URL(seoRequestUrl).origin,
    },
  };
};
