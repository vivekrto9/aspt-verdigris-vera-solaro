# SEO, AEO, and GEO Implementation Guide

This document explains the search and discovery implementation in the Vera
Solaro AstroPages template. Shared builders remain reusable, while the emitted
metadata and structured data are Vera-specific and must describe content that is
actually visible on the corresponding public route.

## Design rules

- Keep all site-wide metadata in one shared layout.
- Build absolute URLs from one shared helper.
- Allow deployments to pin a production domain without requiring one locally.
- Keep robots, sitemap, and `llms.txt` on the same canonical origin.
- Use Content Studio SEO fields when a page already exposes them.
- Add page-specific JSON-LD only when it mirrors visible content.
- Do not change headings, layout, styling, routes, or business logic for SEO alone.
- Do not use `robots.txt` as access control; private routes remain server-protected.

## Architecture map

| Responsibility | File |
| --- | --- |
| Canonical URLs, social metadata, hreflang, and JSON-LD builders | `src/server/generated-site/seo.ts` |
| Shared public-page `<head>` output | `src/layouts/BaseLayout.astro` |
| Sitemap, robots, `llms.txt`, and canonical-origin helpers | `src/server/generated-site/public-seo-routes.ts` |
| HTTP routing for public discovery files | `src/middleware.ts` |
| Brand defaults and optional canonical domain | `src/generated/site-settings.json` |
| Editable page SEO defaults | `src/data/vera/content.ts` and Content Studio |
| Focused regression coverage | `tests/seo-aeo-geo.test.mjs` |

## Request flow

For a normal public page:

1. The page supplies `seo` values to `BaseLayout`.
2. `BaseLayout` resolves the current locale and calls `buildPublicSeo`.
3. The helper selects page values first, then site-setting fallbacks.
4. When `siteSettings.siteUrl` is configured, all absolute URLs are rebased onto
   that production origin. When it is empty, the current request origin is used.
5. The layout emits title, description, robots, canonical, hreflang, Open Graph,
   Twitter metadata, Organization JSON-LD, WebSite JSON-LD, and any valid
   page-specific JSON-LD supplied by the route.

For `/robots.txt`, `/sitemap.xml`, and `/llms.txt`:

1. Astro middleware resolves the canonical origin with `resolveSeoOrigin`.
2. The matching builder creates the response body.
3. Middleware returns the correct plain-text or XML content type and cache policy.
4. Other routes continue through the existing EmDash and Astro middleware chain.

## SEO: search engine metadata

`buildPublicSeo` produces:

- page title and meta description;
- `index,follow` or the page-provided robots directive;
- a canonical URL;
- active-locale hreflang links plus `x-default`;
- Open Graph title, description, image, image alt, and URL;
- Twitter card, title, description, and image;
- the JSON-LD array rendered by the shared layout.

Vera Solaro uses query-parameter localization. Only enabled locales from
`src/data/localization-contract.ts` are emitted. Enabling another locale updates
hreflang and sitemap output through the existing localization contract.

### Content Studio ownership

The editable home page already provides these fields:

- `seo_title`
- `seo_description`
- `seo_canonical_path`
- `seo_robots`
- `og_title`
- `og_description`
- `og_image`
- `og_image_alt`
- `twitter_card`
- `twitter_title`
- `twitter_description`
- `twitter_image`

Routes should pass the existing field values to `BaseLayout`; they should not
duplicate or hard-code metadata that Content Studio owns.

## Canonical production domain

`src/generated/site-settings.json` contains:

```json
{
  "siteSettings": {
    "siteUrl": ""
  }
}
```

The empty value is intentional and is the safe reusable default. It makes URLs
follow the current serving host during local development, previews, and fresh
template deployments.

To lock metadata and discovery files to a production domain, set either:

```json
"siteUrl": "https://www.example.com"
```

or:

```json
"siteUrl": "www.example.com"
```

The resolver preserves the request path and query while replacing only the
origin. Invalid configuration falls back to the request origin. The same setting
controls canonical links, social images, hreflang links, Organization/WebSite
URLs, Article/Breadcrumb URLs, sitemap entries, robots sitemap location, and
`llms.txt` links.

## AEO: answer engine structured data

The shared layout always emits two schemas:

- `Organization`, using brand name, canonical origin, contact email, and phone
  when available;
- `WebSite`, using brand name and canonical origin.

The helper also exposes optional builders:

- `buildFaqJsonLd(items)` creates `FAQPage` only from complete question/answer
  pairs and returns `null` when none are valid.
- `buildArticleJsonLd(input)` creates `Article` only when a headline exists. It
  supports description, author, publication/modification dates, image,
  `mainEntityOfPage`, and publisher.
- `buildBreadcrumbJsonLd(input)` creates `BreadcrumbList` with canonical absolute
  item URLs.

The base routes currently do not show an FAQ, article, or visible breadcrumb.
Therefore they do not emit those page-specific schemas. A derived theme should
add them only when the same content is present in rendered HTML.

### Adding page-specific JSON-LD

Build schema from the same values rendered by the page, then pass it through the
existing `jsonLd` layout prop:

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import { buildFaqJsonLd } from "../server/generated-site/seo.ts";

const faqs = [
  { question: "Visible question", answer: "Visible answer" },
];
const faqJsonLd = buildFaqJsonLd(faqs);
---

<BaseLayout jsonLd={[faqJsonLd].filter(Boolean)}>
  <!-- Render the same faqs here. -->
</BaseLayout>
```

For an article, use a machine-readable ISO date and a real visible author. For
breadcrumbs, mirror the visible breadcrumb labels and destinations exactly.

## GEO: generative-engine discovery

`/llms.txt` is a small Markdown map for AI discovery tools. It contains:

- the configured brand name;
- the configured site description;
- a curated link to the public home page;
- a link to the canonical XML sitemap.

The list is intentionally conservative. Authentication, API, EmDash, health,
preview-only, and `noindex` routes are not promoted in `llms.txt`. When a derived
site adds durable public content, add only canonical, indexable, high-value routes
and keep them aligned with the sitemap.

GEO does not guarantee inclusion or ranking in an AI answer. It makes crawlable,
well-attributed content easier for discovery systems to understand and cite.

## Public discovery routes

### `/robots.txt`

- allows public crawling;
- disallows `/api/` and `/_emdash` from crawler discovery;
- advertises the canonical sitemap URL.

The disallow rules do not replace authentication or route guards.

### `/sitemap.xml`

- lists the repository's declared public routes;
- appends the published `posts` slugs the middleware resolves at request time, so no
  article URL is ever declared in `PUBLIC_ROUTES`, and de-duplicates the result;
- still renders the static routes when the content store is unreachable;
- emits one URL per active locale;
- XML-escapes URLs;
- emits an ISO `lastmod` value;
- uses the configured canonical origin when present.

### `/llms.txt`

- returns Markdown as `text/plain; charset=utf-8`;
- uses Vera's configuration-driven public brand copy;
- points only to curated public content and the sitemap;
- uses the same canonical origin as robots and sitemap.

## Adding a new public route safely

1. Implement the route using the closest existing page/layout pattern.
2. Supply route-specific title, description, canonical path, robots, and social
   metadata through the existing `seo` prop or Content Studio fields.
3. Add the route to `PUBLIC_ROUTES` only when it is canonical and indexable. Articles are
   never added there: `/writing/[slug]` URLs reach the sitemap and `llms.txt` through the
   published `posts` collection.
4. Add it to `llms.txt` only when it is useful, stable, and public.
5. Add FAQ, Article, or Breadcrumb JSON-LD only when matching content is visible.
6. Do not add private, authenticated, operational, preview-only, or `noindex`
   routes to the sitemap or AI map.
7. Run the focused tests and the complete project verification gate.

## Verification

Run the focused contract:

```bash
node --test tests/seo-aeo-geo.test.mjs
```

Run the full repository gate:

```bash
pnpm run verify
git diff --check
```

After starting the built Worker locally, verify:

```bash
curl -s http://127.0.0.1:4331/robots.txt
curl -s http://127.0.0.1:4331/sitemap.xml
curl -s http://127.0.0.1:4331/llms.txt
curl -s http://127.0.0.1:4331/ | grep -E 'canonical|hreflang|application/ld\+json|og:|twitter:'
```

Expected behavior:

- all discovery routes return `200`;
- the home document contains canonical, hreflang, robots, social metadata, and
  Organization/WebSite JSON-LD;
- no existing API, authentication, Content Studio, or generated-site route is
  intercepted;
- configuring `siteUrl` rebases every emitted absolute SEO URL;
- leaving `siteUrl` empty preserves request-origin behavior.

## Implementation scope

This feature changes only SEO helpers, discovery-route builders, middleware
routing, site configuration, focused tests, and this guide. It intentionally does
not modify page headings, H1 semantics, CSS, visible UI, authentication, content,
payments, chat, reports, APIs, EmDash, or generated-site operations.
