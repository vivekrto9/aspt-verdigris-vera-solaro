import type { ContentEntry } from "emdash";
import { getEmDashCollection, getEmDashEntry } from "emdash";
import { defaultLocale, getLocaleFromUrl, localizePath, type SupportedLocale } from "./localization-contract.ts";

export type BlogPostData = {
  title?: unknown;
  excerpt?: unknown;
  content?: unknown;
  category?: unknown;
  featured_image?: unknown;
  seo?: unknown;
  publishedAt?: unknown;
  published_at?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  status?: unknown;
  slug?: unknown;
};

export type BlogImage = {
  src: string;
  alt: string;
};

export type BlogPostSummary = {
  id: string;
  slug: string;
  href: string;
  title: string;
  excerpt: string;
  category: string;
  categorySlug: string;
  readTime: string;
  publishedLabel: string;
  publishedAt: string;
  meta: string;
  image?: BlogImage;
};

export type BlogPostDetail = BlogPostSummary & {
  content: unknown[];
  seoTitle: string;
  seoDescription: string;
  canonicalPath: string;
};

type BlogEntry = ContentEntry<BlogPostData>;

const wordsPerMinute = 220;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const resolved = text(value);
    if (resolved) return resolved;
  }
  return "";
};

const firstIsoDate = (...values: unknown[]) => {
  for (const value of values) {
    const date = value instanceof Date ? value : new Date(firstText(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
};

export const getBlogLocale = (url: string | URL): SupportedLocale =>
  getLocaleFromUrl(typeof url === "string" ? url : url.toString(), defaultLocale);

export const slugifyCategory = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const getBlogImage = (value: unknown): BlogImage | undefined => {
  if (typeof value === "string" && value.trim()) {
    const src = value.startsWith("http") || value.startsWith("/") ? value : `/_emdash/api/media/file/${value}`;
    return { src, alt: "" };
  }

  if (!isRecord(value)) return undefined;
  const src = firstText(value.src, value.url, value.previewUrl, value.id);
  if (!src) return undefined;

  return {
    src: src.startsWith("http") || src.startsWith("/") ? src : `/_emdash/api/media/file/${src}`,
    alt: firstText(value.alt, value.title, value.filename),
  };
};

const plainPortableText = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  const chunks: string[] = [];
  for (const block of value) {
    if (!isRecord(block)) continue;
    if (Array.isArray(block.children)) {
      for (const child of block.children) {
        if (isRecord(child)) {
          const childText = text(child.text);
          if (childText) chunks.push(childText);
        }
      }
    }
  }
  return chunks.join(" ");
};

export const estimateReadTime = (content: unknown, fallbackText = "") => {
  const bodyText = firstText(plainPortableText(content), fallbackText);
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : wordsPerMinute;
  const minutes = Math.max(1, Math.ceil(words / wordsPerMinute));
  return `${minutes} min`;
};

export const formatBlogDate = (value: unknown, locale: string) => {
  const date = value instanceof Date ? value : new Date(firstText(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
  }).format(date);
};

export const normalizeBlogSummary = (entry: BlogEntry, locale: string): BlogPostSummary | undefined => {
  const data = entry.data ?? {};
  const slug = firstText(data.slug, entry.id);
  const title = firstText(data.title);
  if (!slug || !title) return undefined;

  const excerpt = firstText(data.excerpt, plainPortableText(data.content));
  const publishedAt = firstIsoDate(data.publishedAt, data.published_at, data.createdAt, data.created_at);
  const category = firstText(data.category);
  const readTime = estimateReadTime(data.content, excerpt);
  const publishedLabel = formatBlogDate(publishedAt, locale);

  return {
    id: entry.id,
    slug,
    href: localizePath(`/writing/${slug}`, locale as SupportedLocale),
    title,
    excerpt,
    category,
    categorySlug: category ? slugifyCategory(category) : "",
    readTime,
    publishedLabel,
    publishedAt,
    meta: [category, readTime, publishedLabel].filter(Boolean).join(" · "),
    image: getBlogImage(data.featured_image),
  };
};

export const normalizeBlogDetail = (entry: BlogEntry, locale: string): BlogPostDetail | undefined => {
  const summary = normalizeBlogSummary(entry, locale);
  if (!summary) return undefined;

  const data = entry.data ?? {};
  const seo = isRecord(data.seo) ? data.seo : {};
  const seoTitle = firstText(seo.title, data.title);
  const seoDescription = firstText(seo.description, data.excerpt, plainPortableText(data.content));
  const canonicalPath = firstText(seo.canonical) || `/writing/${summary.slug}`;

  return {
    ...summary,
    content: Array.isArray(data.content) ? data.content : [],
    seoTitle,
    seoDescription,
    canonicalPath,
  };
};

// Interim article artwork. The project owner has not supplied per-article media yet, so a set of
// drawn almanac plates from the seed asset store stand in: keyed by slug where a piece has its own
// plate, otherwise by listing
// position so a post keeps the same picture wherever it appears. Replace with real `featured_image`
// values as they arrive.
const useLocalSeedAssets = Boolean(import.meta.env?.DEV);
const localSeedAssetUrl = (fileName: string) =>
  `/@fs${new URL(`../../astropages/assets/${fileName}`, import.meta.url).pathname}`;

export const blogFallbackImages: BlogImage[] = [
  {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-ephemeris-desk.svg")
      : "/_assets/aliases/blog-ephemeris-desk/blog-ephemeris-desk.svg",
    alt: "An open ephemeris with columns of figures under a rising sunburst",
  },
  {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-zodiac-wheel.svg")
      : "/_assets/aliases/blog-zodiac-wheel/blog-zodiac-wheel.svg",
    alt: "A twelve-house wheel printed in verdigris ink on cream",
  },
  {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-night-sky.svg")
      : "/_assets/aliases/blog-night-sky/blog-night-sky.svg",
    alt: "Moon phases arching over the rooftops of Trieste",
  },
  {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-retrograde-loop.svg")
      : "/_assets/aliases/blog-retrograde-loop/blog-retrograde-loop.svg",
    alt: "A planet tracing a retrograde loop across a striped sky",
  },
];

// Per-article plates, drawn to match the piece rather than the position it happens to sit in.
export const blogImagesBySlug: Record<string, BlogImage> = {
  "saturn-is-not-punishing-you": {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-saturn-transit.svg")
      : "/_assets/aliases/blog-saturn-transit/blog-saturn-transit.svg",
    alt: "A ringed planet crossing a striped almanac sky",
  },
  "why-i-still-draw-by-hand": {
    src: useLocalSeedAssets
      ? localSeedAssetUrl("blog-drawn-by-hand.svg")
      : "/_assets/aliases/blog-drawn-by-hand/blog-drawn-by-hand.svg",
    alt: "A brass compass drawing a chart wheel on ruled paper",
  },
};

export const blogImageAt = (post: BlogPostSummary, index: number): BlogImage => {
  if (post.image?.src) return { src: post.image.src, alt: post.image.alt || post.title };
  const plate = blogImagesBySlug[post.slug] ?? blogFallbackImages[index % blogFallbackImages.length];
  return { src: plate.src, alt: plate.alt || post.title };
};

export const listBlogCategories = (posts: BlogPostSummary[]) => {
  const seen = new Map<string, string>();
  for (const post of posts) {
    if (post.categorySlug && !seen.has(post.categorySlug)) seen.set(post.categorySlug, post.category);
  }
  return [...seen].map(([slug, label]) => ({ slug, label }));
};

export const listBlogPosts = async (locale: SupportedLocale) => {
  const result = await getEmDashCollection<"posts", BlogPostData>("posts", {
    locale,
    status: "published",
    // EmDash orders by physical column names; `published_at` is the collection column.
    orderBy: { published_at: "desc" },
  });

  return {
    ...result,
    posts: result.entries.map((entry) => normalizeBlogSummary(entry, locale)).filter(Boolean) as BlogPostSummary[],
  };
};

export const getBlogPost = async (slug: string, locale: SupportedLocale) => {
  const result = await getEmDashEntry<"posts", BlogPostData>("posts", slug, { locale });
  const post = result.entry ? normalizeBlogDetail(result.entry, locale) : undefined;
  return { ...result, post };
};
