# Content fixtures

Source copy that belongs in the CMS, kept out of theme code.

Nothing under `src/` imports these files. They exist so the English article copy that the
Vera Solaro source screens shipped with is not lost, while `/writing` and `/writing/[slug]`
stay fully dynamic: every article, slug and article link comes from the EmDash `posts`
collection at request time (`src/data/blog-posts.ts`). Never hardcode an article, an article
link, or a second article store — see the ownership table in `AGENTS.md`.

## `writing-posts.json`

Ten English pieces recovered from the source `writing` and article screens.

| Field | Notes |
|---|---|
| `slug`, `title`, `excerpt`, `category` | Map 1:1 to `posts` collection fields in `seed/seed.json` |
| `featured_image` | `null` unless the source supplied one; `/writing` falls back to the Verdigris almanac plate |
| `publishedAt` | Derived from the source `Category · read time · Month Year` meta line. Read time is **not** stored — `estimateReadTime` computes it at render |
| `content` | Portable Text, produced with `node scripts/markdown-to-portable-text.mjs < piece.md` |
| `seo` | `title` / `description` / `canonical`; `canonical` must stay `/writing/<slug>` |
| `status` | `saturn-is-not-punishing-you` is `published` (the only complete body the source supplied). The other nine carry title, category, date and excerpt only, so they ship as `draft` until their bodies are written — flip them to published then |

## Loading it

Use the EmDash content workflow from `AGENTS.md` — admin UI or the MCP content tools:

1. `schema_get_collection` on `posts` to confirm fields and check the slug for collision.
2. `content_create` / `content_update` with `_rev` for each entry above.
3. `content_publish` for entries whose `status` is `published`.
4. `content_get` to prove saved state, then open `/writing` and `/writing/<slug>` to prove
   rendered state.

Do not load these with raw SQL, a migration, or `seed/seed.json` — `seed.json` defines the
collection schema and does not store ordinary articles.
