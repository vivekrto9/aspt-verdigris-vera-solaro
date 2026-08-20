import assert from "node:assert/strict";
import test from "node:test";

const {
  estimateReadTime,
  formatBlogDate,
  getBlogImage,
  getBlogLocale,
  listBlogCategories,
  normalizeBlogDetail,
  normalizeBlogSummary,
} = await import("../../src/data/blog-posts.ts");

const portableText = [
  {
    _type: "block",
    _key: "a",
    children: [
      { _type: "span", _key: "a1", text: "Saturn arrives with a measuring tape." },
      { _type: "span", _key: "a2", text: "It asks whether the thing you built holds weight." },
    ],
  },
];

test("normalizes EmDash posts into writing cards", () => {
  const post = normalizeBlogSummary(
    {
      id: "saturn-is-not-punishing-you",
      data: {
        id: "01POST",
        title: "Saturn is not punishing you",
        excerpt: "On the difference between a hard transit and a bad life.",
        content: portableText,
        category: "Transits",
        featured_image: { src: "/media/ephemeris.jpg", alt: "Ephemeris pages" },
        publishedAt: new Date("2026-01-15T00:00:00.000Z"),
      },
      edit: {},
    },
    "en",
  );

  assert.equal(post.slug, "saturn-is-not-punishing-you");
  assert.equal(post.href, "/writing/saturn-is-not-punishing-you");
  assert.equal(post.title, "Saturn is not punishing you");
  assert.equal(post.excerpt, "On the difference between a hard transit and a bad life.");
  assert.equal(post.category, "Transits");
  assert.equal(post.categorySlug, "transits");
  assert.equal(post.readTime, "1 min");
  assert.equal(post.publishedAt, "2026-01-15T00:00:00.000Z");
  assert.equal(post.image.src, "/media/ephemeris.jpg");
  assert.match(post.meta, /^Transits · 1 min · /);
});

test("handles missing optional post fields safely", () => {
  const post = normalizeBlogDetail(
    {
      id: "empty-post",
      data: {
        title: "Minimal Piece",
      },
      edit: {},
    },
    "en",
  );

  assert.equal(post.slug, "empty-post");
  assert.equal(post.excerpt, "");
  assert.equal(post.category, "");
  assert.equal(post.categorySlug, "");
  assert.equal(post.publishedAt, "");
  assert.equal(post.content.length, 0);
  assert.equal(post.image, undefined);
  assert.equal(post.seoTitle, "Minimal Piece");
  assert.equal(post.canonicalPath, "/writing/empty-post");
});

test("derives the writing filter pills from published posts", () => {
  const categories = listBlogCategories([
    { categorySlug: "transits", category: "Transits" },
    { categorySlug: "craft", category: "Craft" },
    { categorySlug: "transits", category: "Transits" },
    { categorySlug: "", category: "" },
  ]);

  assert.deepEqual(categories, [
    { slug: "transits", label: "Transits" },
    { slug: "craft", label: "Craft" },
  ]);
});

test("extracts media references and date/read-time fallbacks", () => {
  assert.deepEqual(getBlogImage("01MEDIA"), {
    src: "/_emdash/api/media/file/01MEDIA",
    alt: "",
  });
  assert.equal(getBlogLocale("https://example.com/writing"), "en");
  assert.match(formatBlogDate(new Date("2026-03-05T00:00:00.000Z"), "en"), /2026/);
  assert.equal(estimateReadTime([], ""), "1 min");
});
