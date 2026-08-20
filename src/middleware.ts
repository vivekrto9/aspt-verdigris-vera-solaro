import emdashMiddleware from "emdash/middleware";
import { defineMiddleware, sequence } from "astro:middleware";

import {
  buildPublicLlmsTxt,
  buildPublicRobotsTxt,
  buildPublicSitemapXml,
  resolveSeoOrigin,
} from "./server/generated-site/public-seo-routes.ts";
import generatedSettings from "./generated/site-settings.json";
import { defaultLocale } from "./data/localization-contract.ts";
import { listBlogPosts } from "./data/blog-posts.ts";
import { astropagesContentReleaseMiddleware } from "./server/generated-site/content-release-middleware.ts";

// Published articles come from the EmDash `posts` collection, never from a route list.
// Discovery documents must still render when the content store is unreachable.
const listPublishedPostLinks = async () => {
  try {
    const { posts } = await listBlogPosts(defaultLocale);
    return posts;
  } catch {
    return [];
  }
};

const publicSeoMiddleware = defineMiddleware(async (context, next) => {
  const seoOrigin = resolveSeoOrigin(context.url.origin, generatedSettings.siteSettings.siteUrl);

  if (context.url.pathname === "/sitemap.xml") {
    const posts = await listPublishedPostLinks();
    return new Response(buildPublicSitemapXml(seoOrigin, new Date(), posts.map((post) => post.href)), {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/xml; charset=utf-8",
      },
    });
  }

  if (context.url.pathname === "/robots.txt") {
    return new Response(buildPublicRobotsTxt(seoOrigin), {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (context.url.pathname === "/llms.txt") {
    const posts = await listPublishedPostLinks();
    return new Response(
      buildPublicLlmsTxt(
        seoOrigin,
        generatedSettings.siteSettings,
        posts.map((post) => ({ path: post.href, label: post.title, note: post.excerpt || post.meta })),
      ),
      {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  return next();
});

export const onRequest = sequence(
  emdashMiddleware,
  astropagesContentReleaseMiddleware,
  publicSeoMiddleware,
);
