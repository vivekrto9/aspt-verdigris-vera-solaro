import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { homeDefaults } from "../src/data/vera/content.ts";

import {
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildOrganizationJsonLd,
  buildPublicSeo,
  buildWebSiteJsonLd,
  resolveSiteRequestUrl,
} from "../src/server/generated-site/seo.ts";
import {
  buildPublicLlmsTxt,
  buildPublicRobotsTxt,
  buildPublicSitemapXml,
  isPublicSeoRoute,
  resolveSeoOrigin,
} from "../src/server/generated-site/public-seo-routes.ts";

const siteSettings = {
  brandName: "Example Brand",
  siteUrl: "example.com",
  seoTitle: "Example Brand Home",
  seoDescription: "A neutral example website.",
  contactEmail: "hello@example.com",
  supportPhone: "+1 555 0100",
};

test("canonical configuration rebases public metadata while preserving request paths", () => {
  assert.equal(
    resolveSiteRequestUrl("https://preview.example.workers.dev/path?locale=en", "example.com"),
    "https://example.com/path?locale=en",
  );
  assert.equal(
    resolveSiteRequestUrl("https://preview.example.workers.dev/path", "not a url"),
    "https://preview.example.workers.dev/path",
  );

  const seo = buildPublicSeo({
    requestUrl: "https://preview.example.workers.dev/?preview=1",
    siteSettings,
    locale: "en",
    canonicalPath: "/",
  });

  assert.equal(seo.canonicalUrl, "https://example.com/");
  assert.equal(Object.hasOwn(seo.og, "image"), false);
  assert.equal(Object.hasOwn(seo.og, "imageAlt"), false);
  assert.equal(Object.hasOwn(seo.twitter, "image"), false);
  assert.deepEqual(seo.alternates, [
    { locale: "en", href: "https://example.com/" },
    { locale: "x-default", href: "https://example.com/" },
  ]);
});

test("social image fields are projected only from route-owned editable SEO content", () => {
  const seo = buildPublicSeo({
    requestUrl: "https://preview.example.workers.dev/?preview=1",
    siteSettings,
    locale: "en",
    canonicalPath: homeDefaults.seo_canonical_path,
    ogImage: homeDefaults.og_image,
    ogImageAlt: homeDefaults.og_image_alt,
    twitterImage: homeDefaults.twitter_image,
  });

  assert.equal(seo.og.image, "https://example.com/_assets/aliases/vera-portrait/vera-portrait.webp");
  assert.equal(seo.og.imageAlt, "Vera Solaro at her desk in Trieste");
  assert.equal(seo.twitter.image, "https://example.com/_assets/aliases/vera-portrait/vera-portrait.webp");

  const layout = readFileSync(new URL("../src/layouts/BaseLayout.astro", import.meta.url), "utf8");
  assert.match(layout, /seo\.twitter\.image \? <meta name="twitter:image"/);
  assert.match(layout, /seo\.og\.image \? <meta property="og:image"/);
  assert.match(layout, /seo\.og\.imageAlt \? <meta property="og:image:alt"/);
});

test("site-wide and page-specific JSON-LD use the configured canonical origin", () => {
  const requestUrl = "https://preview.example.workers.dev/guides/example";
  const organization = buildOrganizationJsonLd({ siteSettings, requestUrl });
  const website = buildWebSiteJsonLd({ siteSettings, requestUrl });
  const breadcrumbs = buildBreadcrumbJsonLd({
    requestUrl,
    siteUrl: siteSettings.siteUrl,
    items: [
      { name: "Guides", path: "/guides" },
      { name: "Example", path: "/guides/example" },
    ],
  });
  const article = buildArticleJsonLd({
    requestUrl,
    siteSettings,
    headline: "Example guide",
    description: "A visible example guide.",
    authorName: "Example Author",
    datePublished: "2026-08-05",
    image: "/images/example.png",
    url: "/guides/example",
  });

  assert.equal(organization.url, "https://example.com");
  assert.equal(website.url, "https://example.com");
  assert.equal(breadcrumbs.itemListElement[1].item, "https://example.com/guides/example");
  assert.equal(article?.mainEntityOfPage, "https://example.com/guides/example");
  assert.equal(article?.image, "https://example.com/images/example.png");
  assert.equal(article?.dateModified, "2026-08-05");
  assert.equal(buildArticleJsonLd({ requestUrl, siteSettings, headline: " " }), null);
});

test("FAQ schema contains only complete visible question and answer pairs", () => {
  const faq = buildFaqJsonLd([
    { question: "What is included?", answer: "Only content visible on the page." },
    { question: "Missing answer", answer: " " },
  ]);

  assert.equal(faq?.mainEntity.length, 1);
  assert.equal(faq?.mainEntity[0].name, "What is included?");
  assert.equal(buildFaqJsonLd([]), null);
});

test("public discovery routes expose Vera pages without indexing private account access", () => {
  const canonicalOrigin = resolveSeoOrigin("https://preview.example.workers.dev", siteSettings.siteUrl);
  const publishedPosts = [
    { path: "/writing/saturn-is-not-punishing-you", label: "Saturn is not punishing you", note: "A transit is not a verdict." },
  ];
  const sitemap = buildPublicSitemapXml(
    canonicalOrigin,
    new Date("2026-08-05T00:00:00.000Z"),
    publishedPosts.map((post) => post.path),
  );
  const emptySitemap = buildPublicSitemapXml(canonicalOrigin, new Date("2026-08-05T00:00:00.000Z"));
  const robots = buildPublicRobotsTxt(canonicalOrigin);
  const llms = buildPublicLlmsTxt(canonicalOrigin, siteSettings, publishedPosts);

  assert.equal(canonicalOrigin, "https://example.com");
  assert.equal(resolveSeoOrigin("https://preview.example.workers.dev", "not a url"), "https://preview.example.workers.dev");
  assert.match(sitemap, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/readings\/year-ahead<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/writing<\/loc>/);
  // Article URLs come from the caller's published `posts`, never from a hardcoded route list.
  assert.match(sitemap, /<loc>https:\/\/example\.com\/writing\/saturn-is-not-punishing-you<\/loc>/);
  assert.doesNotMatch(emptySitemap, /<loc>https:\/\/example\.com\/writing\/[a-z-]+<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/letters<\/loc>/);
  assert.doesNotMatch(sitemap, /<loc>https:\/\/example\.com\/(?:login|signup|account|reset-password)<\/loc>/);
  assert.doesNotMatch(sitemap, /preview\.example\.workers\.dev/);
  assert.match(robots, /Disallow: \/_emdash/);
  assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  assert.match(llms, /^# Example Brand$/m);
  assert.match(llms, /\[The sky kept a note for you\.\]\(https:\/\/example\.com\/\)/);
  assert.match(llms, /\[The Year Ahead\]\(https:\/\/example\.com\/readings\/year-ahead\)/);
  assert.match(llms, /\[Saturn is not punishing you\]\(https:\/\/example\.com\/writing\/saturn-is-not-punishing-you\)/);
  assert.doesNotMatch(
    buildPublicLlmsTxt(canonicalOrigin, siteSettings),
    /\(https:\/\/example\.com\/writing\/[a-z-]+\)/,
  );
  assert.match(llms, /\[XML sitemap\]\(https:\/\/example\.com\/sitemap\.xml\)/);
  assert.doesNotMatch(llms, /kundli|vedic|jyotish/i);
});

test("all public SEO endpoints are recognized without matching unrelated routes", () => {
  assert.equal(isPublicSeoRoute("/robots.txt"), true);
  assert.equal(isPublicSeoRoute("/sitemap.xml"), true);
  assert.equal(isPublicSeoRoute("/llms.txt"), true);
  assert.equal(isPublicSeoRoute("/_emdash/api/mcp"), false);
  assert.equal(isPublicSeoRoute("/api/astropages/generated-site/health"), false);
});
