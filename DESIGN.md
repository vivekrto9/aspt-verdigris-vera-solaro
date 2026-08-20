# Design — Vera Solaro Verdigris Almanac

This document describes the production design and interaction contract for the Verdigris edition of the Vera Solaro template. `../verdigris-html-source/Verdigris Almanac (standalone-src).dc.html` is the authority for the homepage, global chrome, typography, palette, rules, texture, and desktop composition. The inherited Vera routes remain the authority for production behavior and copy; they are re-skinned through the same Verdigris tokens without changing their semantics.

## Visual thesis

The site should feel like a cool archival almanac found on a Trieste reading-room desk: chalky paper, deep verdigris ink, berry proof marks, mint booking stamps, fine dotted texture, double newspaper rules, and restrained offset shadows. It is intimate and specific, not a generic wellness site or software dashboard.

The canonical type system is:

- Ultra for display statements and section headings;
- Rye for the Vera wordmark and handwritten signature moments;
- Newsreader 300/400/600/italic for long reading and editorial copy;
- Familjen Grotesk 400/500/600 for labels, navigation, prices, metadata, and controls.

Fonts are self-hosted through the existing package imports in `src/components/vera/VeraFrame.astro`; public pages must not add a remote font stylesheet.

The core palette is Ink `#0E241E`, Paper `#F1F3EC`, Berry `#8E2F53`, Jade `#3E8C77`, Mint `#7FCBB1`, Wash `#DDE3D6`, and Rule `#B6BFAF`. `src/styles/vera.css` exposes the inherited semantic variables and `src/styles/verdigris.css` owns the Verdigris composition and overrides. Panels use square corners, 1px or double rules, dotted dividers, and uppercase tracked labels.

## Source map

| Canonical source | Production surfaces |
| --- | --- |
| `Verdigris Almanac (standalone-src).dc.html` | Home, global header/footer, typography, color, texture, rules, and editorial layout |
| Inherited Vera route implementation | Reading detail, booking, availability, intake, payment, confirmation, waitlist, and failure states |
| Inherited Vera route implementation | Writing, article, About, questions, contact, legal, auth, 404, closed, and account states |

Warm Almanac and Midnight Ledger styling are not part of this edition. Do not reintroduce rounded warm-paper cards, burnt-orange/mustard accents, or blue ledger styling.

## Production architecture

`VeraFrame.astro` composes the shared layout, header, footer, consent controls, self-hosted fonts, SEO, and Content Studio overlay. `src/styles/vera.css` retains the inherited component geometry while `src/styles/verdigris.css` applies the shared edition tokens and source-faithful homepage. `src/data/vera/content.ts` remains the only source-default registry for visitor-facing Vera copy and SEO. `src/data/public-copy.ts` is a compatibility adapter to those same Vera defaults; it must not contain a second copy system.

The existing Content Studio contract contains exactly 22 collection/entry pairs. The same set must remain in:

- `src/data/vera/content.ts` (`veraEntries`);
- `src/builder/registry.ts` release targets;
- `template.manifest.json` public editable entries;
- `src/data/localization-contract.ts` public editable entries.

Every visible static label, paragraph, CTA, error, empty state, consent disclosure, SEO field, and meaningful image alternative belongs to one of those existing entries. Keep each physical collection at or below the 84-field platform ceiling; split fields only across the existing Vera entries. Runtime values such as service price, slot time, booking number, payment state, file metadata, and account data come from authoritative APIs and are inserted with safe text APIs.

Do not add parallel JSON contracts, asset metadata sidecars, or a second content registry. The six standard `astropages/*.json` manifests are the complete top-level manifest boundary.

## Route composition

- `/` follows the Verdigris source order: folio/masthead, facts–headline–sky hero, desk plate, offered readings, portrait/about, correspondence, available journal entries, booking CTA, and four-column footer. Reading cards are filtered by `offeredReadingIndexes`; one offered reading renders as one centered featured panel. The unsupported year-almanac and unavailable monthly-letter band are omitted rather than filled with fake data.
- `/readings` is the three-reading catalog. Each `/readings/[service]` route is a real service-detail screen with source facts, inclusions, preparation, FAQs, and provider-backed availability/booking action.
- `/booking` retains the source four-step journey. Calendly supplies live slots behind the custom source UI; Stripe Elements supplies card collection. Browser state never fabricates a confirmed payment or sitting.
- `/writing` and `/writing/[slug]` read the EmDash `posts` collection through `src/data/blog-posts.ts`; no article, slug, or article link is hardcoded in a route, component, or discovery document. The source-provided English copy (nine listing pieces plus the complete Saturn body) ships as a CMS-loadable fixture in `docs/content-fixtures/`, not as theme code.
- `/letters` exposes the distinct signup, pending, confirmed, and sample compositions rather than merging them into a generic page.
- `/account` exposes only server-authorized customer data and the source overview, move, cancel, receipt, and reading-room states.
- `/closed` changes the global books-open chrome as well as the page body.
- Auth routes are necessary utility surfaces requested for the account feature. Their Studio-backed text follows Vera’s source voice, but must never be represented as literal source copy when no matching source screen exists.

## Imagery and assets

The source package supplies exactly four image byte assets: Vera portrait, ephemeris pages, brass protractor, and night sky. They are registered in the existing Project Assets manifest and served through stable alias URLs. They remain confined to their four authorized home slots.

Article artwork is the one approved exception: the project owner asked for the ephemeris, protractor and night-sky photographs to stand in for missing `featured_image` values on the journal cards and the `/writing` featured card. `blogFallbackImages` in `src/data/blog-posts.ts` is that stand-in's single owner, keyed by listing position, and it retires as real per-article media arrives.

The About hero portrait is a second project-owner-approved image slot. The generated `about-vera-portrait.jpg` asset is registered under the stable `about-vera-portrait` alias and is used only by `/about`; its alternative text remains editable through `vera_about/main`.

Every other canonical image slot must still exist in its source position with truthful editable alt text and a designed `VeraImage` placeholder until the project owner supplies media. Do not reuse one of the registered images to fill a missing room, letter, map, holiday, avatar, chart, or account artifact.

## Interaction and state truth

Source `div onClick` prototypes become semantic links, buttons, fieldsets, forms, labels, and disclosure controls. Preserve the pixels and copy while adding keyboard operation, visible focus, Escape behavior, focus transfer after panel changes, live regions, disabled/pending states, and reduced-motion behavior.

All commercial state is server-authoritative:

- Calendly availability is queried in bounded seven-day provider windows;
- D1 owns the selected service/mode, twelve-minute hold, intake, quote, gift reservation, and booking status;
- Stripe Elements and signed Stripe webhooks own payment truth;
- Calendly invitees are created or reconciled only through the site policy path;
- account, files, reports, messages, invoices, refunds, and reschedules require verified ownership;
- browser clocks, return URLs, query flags, and custom events never create paid or completed state.

Do not embed a raw Calendly widget; it would replace the source UI. Do not render raw card fields. Do not persist names, email addresses, birth details, or provider secrets in browser storage or analytics.

## Responsive contract

The source defines a fixed 1440px desktop canvas and explicitly leaves mobile unbuilt. Production mobile behavior is therefore derived, not copied. Preserve the desktop hierarchy at source dimensions, then reflow it deliberately:

- keep the primary Book action reachable in the mobile menu;
- stack rails and cards in reading order without moving price/due information after a payment action;
- retain recognizable zodiac and paper ornament at a reduced scale rather than removing the identity;
- use fluid display type, safe gutters, 44px-class public controls, and no horizontal overflow;
- keep long article, legal, letter, receipt, and account content readable at 320–430px widths.

Desktop and mobile must be visually checked with real content and empty/error/provider-blocked states; contract tests alone are not visual evidence.

## Privacy and analytics

The source privacy text originally promised no analytics. The approved production exception is consent-gated private PostHog analytics with autocapture and session recording disabled. Only allowlisted operational event names and non-personal properties may be sent. No name, email, phone, birth data, location, free-form message, booking/manage token, account capability, or sensitive URL query may leave the browser.

The legal and consent copy explaining this exception remains editable in the existing Studio entries. When analytics is not configured or consent is declined, no PostHog request is made.

## Extension rules

1. Start from the Verdigris source composition and shared Verdigris tokens; do not introduce a generic component-library aesthetic.
2. Use only source copy for source-defined surfaces. New utility/security copy must be necessary, Studio-backed where visitor-visible, and clearly treated as a production exception.
3. Add behavior behind the source UI; never trade visual fidelity for a provider embed.
4. Reuse the existing 22 Studio entries and six standard manifests. Do not create sidecar contracts.
5. Keep placeholder truth: missing bytes stay visibly intentional placeholders until supplied.
6. Implement complete hover, focus-visible, disabled, pending, error, success, empty, and reduced-motion behavior for every interaction.
7. Verify provider failures, reloads, duplicate webhooks, hold expiry, cancellation/refund, account recovery, and private-file authorization as well as the happy path.
8. Update this document, relevant existing tests, and the existing manifests whenever production behavior changes.
