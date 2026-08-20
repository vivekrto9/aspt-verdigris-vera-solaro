# Content Studio Approved Changes

Canonical template: `aspt-divyastra`

This file contains only Content Studio changes that were approved by the user and implemented in this canonical template before replication to the other AstroPages templates.

## Replication contract for every AstroPages theme

Purpose: reproduce the complete approved Content Studio from `aspt-divyastra` in every theme with the same structure, color system, typography, sizing, motion, responsive behavior, accessibility, and functionality. This is a parity task, not a theme-specific redesign.

Canonical implementation lineage starts at `3b301fe` (`feat(content-studio): refine canonical editor UI`). Later approved commits may extend it; the current canonical files and hashes in this document are authoritative.

### Non-negotiable scope

- The Content Studio builder chrome must look and behave the same in every theme, regardless of the public site's brand colors.
- Do not recolor the builder to match an individual theme. The peacock-teal/copper system is deliberately cross-theme.
- Do not change public-site components, content models, routes, database behavior, or brand styling while replicating this work.
- Do not replace, rename, restyle, normalize, or copy any public brand logo or other brand asset between templates. Every template keeps its own logo files, manifest entries, component references, sizing, and fallback treatment.
- Preserve template-specific builder endpoints, collection names, SEO targets, permissions, CSRF values, locales, and review-target data.
- Preserve all approved `data-builder-*` attributes because the client behavior and tests depend on them.
- Use the canonical files as the source of truth. The detailed rules below explain intent and acceptance criteria; they do not permit visual or behavioral drift.
- Do not restore the removed floating field/locale context pill.
- Do not mark a theme complete until its focused tests and production build pass.

### Golden source files

Copy or faithfully merge these canonical files from `aspt-divyastra`:

- `src/builder/BuilderToolbar.astro` — rendered structure, labels, controls, data attributes, launcher preview, count badge, menu, editing dock, and inspector.
- `src/builder/BuilderStyles.astro` — complete builder-only visual system, responsive rules, state styling, motion, and reduced-motion support.
- `src/builder/BuilderClient.astro` — panel lifecycle, live draft state, editing workflow, guarded close behavior, dragging, viewport clamping, and inspector coordination.
- `tests/content-studio-ui-contract.test.mjs` — parity contract for the approved UI and functionality.
- `CONTENT_STUDIO_APPROVED_CHANGES.md` — copy this replication specification into the target repository after implementation.

Canonical SHA-256 values for the current approved implementation:

```text
8b89986fd6adf47f30ca83d57a1d35294b2b62fa9657e394edbc45238061eeb0  src/builder/BuilderClient.astro
7af58cebff4f9be0fbd458ff060fb91394eeb655de69b7e5e58e96fdcb53e22c  src/builder/BuilderStyles.astro
1a9170e45fc6d28d9e0389c8f2c220281bb03524d76f5e19eb422f0c3809318e  src/builder/BuilderToolbar.astro
d11ba5e284a400da9afa43157e197a84f4f440fee2021245cbeb0222d91f7626  tests/content-studio-ui-contract.test.mjs
```

The canonical focused test also contains Divyastra-specific cart, wishlist, checkout, and schema-preview assertions. Other template families use the shared seven-test parity subset below, which covers every cross-theme Content Studio requirement without asserting visitor features that the target does not provide:

```text
8e9fc26a268cf48964ba4307be83bdfc17da0adb4a653ec77a1e928a5b41cde5  tests/content-studio-ui-contract.test.mjs
```

Exact hashes are expected when a target has the same builder API. If a target genuinely has template-specific builder integration differences, preserve only those required inputs while keeping the DOM contract, styles, labels, state logic, and interactions equivalent. Document every necessary divergence.

Vera Solaro has one approved identity-only divergence: the canonical generic SEO preview fallback is replaced with the customer-visible `Vera Solaro` name. No DOM, behavior, endpoint, style, or state logic changes with it. The resulting target hashes are:

```text
ddbfc1ba81297ac634835f65de925abdf5b97742c2353e595ce968f6227566f7  src/builder/BuilderClient.astro
c30cb775cb7c3e905f1fdfa1bbd31fe452b7637c9ef536c4d27f06d51c35e29c  src/builder/BuilderToolbar.astro
```

### Theme discovery and current scope

Replication applies to every repository containing `src/builder/BuilderStyles.astro`, not only folders whose name begins with `aspt-divyastra`.

Use this discovery command from the workspace root before starting:

```sh
find /Users/ashutoshsingh/Desktop/astro-pages -path '*/node_modules' -prune -o -path '*/src/builder/BuilderStyles.astro' -print | sort
```

Current discovered target families include:

- Workspace-root themes: `aspt-costar`, `aspt-costar-verdant`, `aspt-divyastra-Celestial-Indigo`, `aspt-divyastra-Sacred-Grove`, `aspt-divyastra-electric-Bloom`, and `sidera-warm-modern`.
- `tempates/` themes: Astra Guru, Astrologer Portfolio/Profile, Costar, Divyastra, Jyoti Connect, Jyotish Live, Pandit Style, Tarot Reading, Western Chani Astro, and Western Single Astrologer variants.
- `aspt-divyastra` is the canonical completed theme and must not be overwritten from another variant.

The `tempates` directory name is intentionally recorded with its current workspace spelling. Re-run discovery rather than relying only on this list because themes may be added later.

### Required rendered structure

Keep this ownership and order. Exact Astro conditions may vary only where the target already has legitimate permission or SEO capability differences.

```text
builder shell [data-builder-toolbar]
├── launcher wrap
│   ├── clickable hover preview [data-builder-launcher-label]
│   │   ├── heading: Content editor
│   │   ├── live summary: Edit this page / N unpublished change(s)
│   │   └── circular north-east SVG arrow
│   └── 60px launcher [data-builder-launcher]
│       ├── pencil/edit SVG icon
│       └── live unpublished count [data-builder-draft-count]
├── main menu [data-builder-menu]
│   ├── title, locale/path pill, compact expandable close control
│   ├── Edit content switch
│   ├── Page SEO, Review changes, Preview site
│   └── status, Save draft, Publish changes
├── real-error popover [data-builder-error-popover]
└── editing dock [data-builder-editing-dock]
    ├── Editing eyebrow, selected field, Details
    ├── status and unsaved-edit count
    ├── inline notice/error region
    └── Save draft, Review changes, Publish changes, Done

inspector sibling [data-builder-inspector]
├── title, subtitle, compact expandable close control
├── Content / Page SEO / Changes tabs
└── field, SEO, and change-review panels
```

There must be no `data-builder-context-chip`, `.builder-context-chip`, or `updateContextChip` implementation.

### Exact visual tokens

Use these values without substituting theme variables:

```css
--builder-surface-deep: #2b625d;
--builder-surface: #2f6a64;
--builder-surface-raised: #37756f;
--builder-border: rgba(20, 184, 166, 0.2);
--builder-border-strong: rgba(20, 184, 166, 0.56);
--builder-gold-border: rgba(168, 111, 61, 0.62);
--builder-gold-border-soft: rgba(214, 164, 111, 0.24);
--builder-text: #fff8ea;
--builder-text-muted: rgba(255, 248, 234, 0.68);
--builder-ink: #241510;
--builder-accent: #0d9488;
--builder-accent-hover: #14b8a6;
--builder-accent-deep: #0f766e;
--builder-control-top: #285e59;
--builder-control-bottom: #1d4f4a;
--builder-control-hover-top: #26736a;
--builder-control-hover-bottom: #185952;
--builder-gold: #a86f3d;
--builder-gold-soft: #d6a46f;
--builder-gold-text: #ffdca8;
--builder-gold-text-strong: #ffebc8;
--builder-success: #497a5a;
--builder-success-text: #bce8c5;
--builder-info-text: #a9d4ed;
--builder-link: #b9d7ff;
--builder-danger-text: #f5b8ad;
--builder-shadow: rgba(13, 51, 48, 0.42);
```

Color hierarchy:

- Modal surfaces use `--builder-surface` with the canonical subtle copper-tinted overlay and blur.
- Enabled secondary controls use the deeper `--builder-control-top` to `--builder-control-bottom` gradient so they remain distinct from modal surfaces.
- Enabled primary Save/Publish controls use the teal accent gradient with a restrained copper edge/highlight.
- Disabled controls are flat `rgba(12, 53, 49, 0.22)`, have no shadow, and use `rgba(255, 248, 234, 0.34)` text.
- Hovered enabled controls use the control-hover gradient. Disabled controls never lift or animate.
- Copper is trim, not a dominant fill: borders, separators, active edges, checked switch thumb, scrollbar, and small highlights only.
- Warm-gold text is reserved for readable state, eyebrow, section, and active-tab emphasis.

### Exact typography and control sizing

- Builder font stack: `"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Base builder size: `14px`; base line-height: `1.35`.
- Menu title: `1.02rem`, weight `950`, line-height `1.2`.
- Locale/path and status pills: `0.78rem`, weight `900`, padding `7px 10px`.
- Actions: minimum height `40px`, radius `14px`, weight `900`.
- Edit-mode control: minimum height `48px`, radius `16px`, weight `950`.
- Toggle track: `42px × 24px`; thumb: `16px`; checked translation: `18px`.
- Dock eyebrow: `0.76rem`, weight `950`, uppercase, letter-spacing `0.08em`.
- Dock selected-field title: `0.98rem`, weight `950`.
- Dock Details: minimum height `34px`, `0.82rem`, weight `900`.
- Dock notice: `0.82rem`, weight `850`, line-height `1.45`; warning icon `0.9rem`.
- Inspector subtitle: `0.84rem`, weight `800`.
- Inspector tabs: minimum height `34px`, horizontal padding `14px`, weight `900`.
- SEO labels: `0.86rem`, weight `850`; counters `0.74rem`; section legends `0.9rem`, weight `950`.
- Close control: `26px × 26px` at rest; expands to `75px`; cross `1.05rem`; label `0.86rem`; both weight `500`.

### Exact geometry and responsive rules

- Launcher shell and button: `60px × 60px`, radius `18px`.
- Default launcher position: `24px` from right and bottom; `12px` on screens at or below `720px`.
- Launcher icon: inline `PencilLine` edit SVG, `28px × 28px`, using `currentColor`; do not restore the sparkle glyph or add an external asset dependency.
- Draft count: `20px` circle, offset `-7px` top/right; multi-digit counts may widen with `5px` horizontal padding.
- Hover preview: `72px` away from the launcher, `18px` radius, `10px 10px 10px 14px` padding, `12px` pointer bridge.
- Hover-preview heading: `0.86rem`; summary: `0.7rem`; arrow chip: `26px` with a `14px` SVG.
- Main menu: maximum canonical width `410px`, radius `24px`, header padding `18px`, content/footer padding `14px 18px`.
- Editing dock: maximum canonical width `420px`, radius `20px`, padding `12px`, gap `12px`.
- Inspector: maximum width `420px`, top `112px`, right `24px`, bottom `104px`, radius `22px`; panel content scrolls internally.
- When inspector and dock coexist at desktop widths, keep exactly `20px` between them and cap dock height to prevent viewport overflow.
- Reserve reduced inspector height only while the editing dock is actually visible.
- On screens at or below `720px`: menu/dock width `min(380px, calc(100vw - 24px))`; menu radius `22px`; dock padding `10px`; inspector uses `18px 10px 86px 10px`; inspector radius `20px`.
- All movable panels must be clamped to a `12px` viewport margin and become internally scrollable if their content is taller than available space.

### Motion contract

- Use `setPanelVisible` so close animations finish before applying `hidden`.
- Menu and editing dock: fade plus `translateY(10px) scale(0.985)`; `210ms` opacity/visibility and `240ms` transform.
- Inspector: fade plus `translateX(14px) scale(0.99)` with the same `210–240ms` timing.
- Standard clickable transitions: approximately `170–180ms`.
- Close expansion: width/min-width `280ms`, gap `260ms`, label opacity `190ms` with `55ms` delay.
- Hover elevation: `translateY(-1px)` only inside `@media (hover: hover)`.
- Pressed controls: `scale(0.985)` with `80ms` transition duration.
- Hover-preview arrow glyph moves `2px` right and `2px` up; its circle stays fixed.
- Apply `prefers-reduced-motion: reduce` to panels, launcher, nested preview arrow, close labels, actions, switch, dock details, and inspector tabs/buttons.

### Functional state contract

| State | Status label | Save | Review | Publish | Required behavior |
| --- | --- | --- | --- | --- | --- |
| `idle` | Published | Disabled | Disabled | Disabled | No saved or local changes. |
| `unsaved` | Unsaved changes | Enabled | Disabled | Disabled | Local edits exist and must be saved first. |
| `saving` | Saving... | Disabled | Disabled | Disabled | Preserve transient state during background diff refresh. |
| `draft` | Unpublished draft | Disabled | Enabled | Enabled only with permission and Studio mode | Saved unpublished changes exist. |
| `publishing` | Publishing... | Disabled | Disabled | Disabled | Preserve transient state until publish completes/fails. |
| `published` | Published | Disabled | Disabled | Disabled | Clear launcher badge and unpublished summary immediately. |
| `error` | Error | Enabled for retry | Enabled only if a saved draft still exists | Disabled | Show real error styling and message. |

Required interactions:

- Launcher click opens/closes the main menu when editing is inactive.
- Entering edit mode closes the main menu and opens the editing dock.
- Clicking the launcher while editing or while the editing dock is active routes through the same guarded close function as Done; it must never open a second menu behind the dock.
- If unsaved edits exist, launcher/Done keeps editing open and shows `Save this draft before closing edit mode.`
- This unsaved-exit message is a notice with a warning triangle, not an error card. Hide the redundant left status pill while the notice is visible.
- A saved draft does not block leaving edit mode; only local unsaved edits do.
- Details opens the Content inspector for the selected field.
- Page SEO toggles the SEO inspector; Review changes opens Changes.
- Inspector close and Escape close the inspector without discarding edits.
- The launcher hover preview is hidden while edit mode is active or a panel owns the action.
- The hover preview itself is a real clickable button and opens Content Studio.

### Live unpublished-count contract

- Server-rendered `hasSavedDraft` is only the initial fallback.
- On startup with a saved draft, fetch the real diff count without requiring a refresh.
- Update the launcher badge, hover summary, local draft flag, toolbar dataset, Publish availability, Review availability, and stable status together.
- Use `1 unpublished change` and `N unpublished changes` with correct pluralization.
- Refresh after Save draft; clear immediately after Publish changes.
- Ignore superseded diff responses using a request/version guard.
- If the diff request fails, keep the existing fallback state rather than incorrectly clearing the draft.
- A background diff response must not overwrite `saving`, `publishing`, or `error` states.
- Single digits stay circular; multi-digit counts become a compact pill.

### Dragging and viewport-safety contract

- Support primary mouse, pen, and touch pointer dragging.
- Require at least `5px` movement before starting a drag so ordinary clicks remain clicks.
- Use pointer capture and clear drag state on `pointerup`, `pointercancel`, and `lostpointercapture`.
- Suppress the generated click after a completed drag.
- Hide the hover preview during drag and keep it suppressed after release until the pointer leaves the launcher; blur pointer-created focus so the preview cannot remain stuck.
- Persist `{ left, top }` to local storage key `astropages-content-studio-launcher-position`.
- Restore and re-clamp the position after reload and viewport resize.
- Keep the launcher inside a `12px` margin.
- Anchor menu/dock positioning to the always-present 60px shell, not the launcher wrap that is hidden while the inspector is open.
- Prefer panel placement above or below based on available room; clamp left/top/max-height and enable internal vertical scrolling.
- Flip the hover preview to the side with more room.

### Accessibility and edge-case contract

- Keep real buttons for launcher, hover preview, close controls, tabs, actions, Details, and Done.
- Preserve `aria-expanded`, `aria-controls`, `aria-label`, tab roles, `aria-selected`, status live regions, and focus-visible outlines.
- Close labels remain in the DOM even when visually collapsed.
- Keyboard focus must reveal the expanded Close label just like hover.
- Escape must not close the inspector while an inline text editor owns Escape.
- Disabled actions use native `disabled`, do not animate, and remain visually distinct from active actions.
- Touch devices must not receive sticky hover elevation.
- Storage failures must not disable dragging.
- Invalid stored launcher JSON must fall back to the CSS default.
- Resizing must re-clamp the launcher, menu, dock, inspector relationship, and selected-field UI.
- Opening Page SEO or Changes without the editing dock must retain the inspector's normal height.

### Replication procedure per theme

1. Read the target repository's `AGENTS.md` and inspect its dirty working tree. Do not overwrite unrelated user changes.
2. Confirm the target has the builder toolbar, styles, client, endpoints, diff endpoint, permissions, locale, collection/entry, SEO target, and review-target inputs.
3. Compare the target builder files with the golden files. Prefer copying the canonical files exactly when integration signatures match.
4. If signatures differ, merge the target-specific server inputs into the canonical toolbar while preserving the required DOM tree and every behavioral data attribute.
5. Port the canonical client behavior as one coordinated unit. Do not cherry-pick only colors or dragging.
6. Port the complete canonical styles, including mobile rules and reduced-motion rules. Do not mix the old theme-colored modal CSS with the new structure.
7. Remove the context-pill markup, CSS, variables, listeners, and helper if present.
8. Add/update the focused UI contract test and run all target tests.
9. Run the target production build and `git diff --check`.
10. Manually verify light, dark, green, and image-heavy pages at desktop and mobile widths.
11. Verify launcher drag at every viewport edge, panel overflow, hover suppression after drag, live counts, unsaved close guard, Save, Review, Publish, Page SEO, Changes, close animation, and reduced motion.
12. Copy this Markdown file into the target and record the target's commit/hash only after verification.

### Required verification commands

Use the target package manager when it differs, but perform equivalent checks:

```sh
node --test tests/content-studio-ui-contract.test.mjs
node --test --test-concurrency=1 "tests/**/*.test.mjs"
pnpm run build
git diff --check
```

Acceptance requires zero focused-test failures, zero full-suite failures, a successful production build, no syntax errors, no unintended public-theme changes, and no remaining old Content Studio context-pill implementation.

### Replication status

- `aspt-divyastra`: canonical implementation complete; use its current approved builder files and the hashes recorded above.
- Divyastra workspace variants have complete implementation parity and automated verification on 2026-08-04: `aspt-divyastra-Celestial-Indigo`, `aspt-divyastra-Sacred-Grove`, and `aspt-divyastra-electric-Bloom`.
- Divyastra `tempates/` copies have complete implementation parity and automated verification on 2026-08-04: `aspt-divyastra`, `aspt-divyastra-Celestial-Indigo`, `aspt-divyastra-Sacred-Grove`, and `aspt-divyastra-electric-Bloom`.
- Each completed Divyastra target matches all four canonical hashes above and passes the focused Content Studio contract, complete test suite, typecheck, production build, safety scan, D1 schema check, Cloudflare runtime contract, and `git diff --check`.
- All 31 discovered non-Divyastra themes received the approved implementation on 2026-08-04. Every one matches the canonical `BuilderStyles.astro` hash and the shared seven-test contract hash recorded above.
- All 31 non-Divyastra themes pass the focused Content Studio contract, production build, project-assets contract, safety scan, D1 schema check, and Cloudflare runtime contract.
- Thirty of the 31 non-Divyastra themes pass typecheck. `sidera-warm-modern` retains 11 pre-existing type diagnostics outside `src/builder/` (auth locale types, transit copy, and account/astrologer page props); its Content Studio tests and production build pass.
- Thirty of the 31 non-Divyastra themes pass their complete test suite after reconciliation with remote `main`. `sidera-warm-modern` retains one unrelated transit registry/count mismatch (`46` actual versus `51` expected); its focused Content Studio tests and production build pass.
- No public brand-logo or brand-asset file was changed by the Content Studio rollout.
- Live desktop/mobile browser inspection is delegated to the user and is intentionally excluded from the automated rollout gate.
- Similar appearance or shared ancestry is not completion; every discovered target was inspected and tested separately.

### Required template-family divergences

These are approved integration-preserving differences from the byte-identical canonical client/toolbar. They do not permit DOM, visual, interaction, or state-contract drift.

- Co-Star family: keep its existing content endpoints, SEO field capabilities, review targets, and content-entry inputs.
- Sidera Warm Modern: keep pending-edit session persistence/restoration, saved-draft preview hydration, reload capture, and editable-surface recovery.
- Astra Guru and Pandit Style: keep their existing builder inputs and content endpoint configuration.
- Astrologer Portfolio/Profile and Tarot Reading: keep their existing builder inputs, SEO capability, and preview metadata.
- Jyoti Connect variants: keep each variant's endpoint/toolbar inputs. `jyoti-connect-rich-spiritual` retains its template-namespaced cookies and caches; the canonical shared launcher-position storage key is the only intentional cross-template browser key.
- Jyotish Live variants: keep known draft-target optimization, target-specific review inputs, and their established `_preview` endpoint handling.
- Western Chani Astro variants: keep draft-diff caching/request coalescing, cache invalidation, template-token replacement, and dynamic editable-value handling.
- Western Single Astrologer: keep known draft-target optimization, its SEO/review inputs, and established `_preview` endpoint handling.
- Vera Solaro: keep the approved customer-name fallback in search and social previews; this identity-only substitution is documented with target hashes above.
- Toolbar fallback titles, endpoint defaults, SEO field lists, permission props, and review-target data may differ only where the template's existing server integration requires them.

## CS-UI-001 - Cross-theme studio accent color

Status: approved and implemented in canonical template

Request: Replace the muddy red/orange Content Studio control color with a color that remains visible on both light pages and dark theme surfaces.

Decision: Use a mid-depth peacock teal palette for Content Studio surfaces, chrome, and editable outlines.

- Surface deep: `#2b625d`
- Surface: `#2f6a64`
- Raised surface: `#37756f`
- Accent: `#0d9488`
- Hover accent: `#14b8a6`
- Deep accent: `#0f766e`
- Copper: `#a86f3d`
- Soft copper: `#d6a46f`
- Copper border: `rgba(168, 111, 61, 0.62)`
- Soft copper separator: `rgba(214, 164, 111, 0.24)`
- Bright hover stop: `#14b8a6`

Affected file:

- `src/builder/BuilderStyles.astro`

Replication notes:

- Apply only to Content Studio builder styles, not the public site brand theme.
- Replace the old brown modal surfaces and red builder accent/border/shadow values with a medium teal system, tuned slightly darker than the first lightened pass.
- Use teal for modal surfaces, secondary action fills, toggles, focus states, and editable outlines.
- Give enabled secondary CTAs and the edit-mode control a deeper teal gradient with a soft inner highlight so they remain visually separate from the modal surface without adding more copper.
- Use copper/bronze sparingly for modal borders, separators, active tab edge/text, checked switch thumb, scrollbar, and enabled CTA edge/highlight.
- Enabled primary CTAs use a teal fill with copper edge/highlight; disabled CTAs use a flat muted teal ghost style.
- Keep copper labels for secondary information and section headings.
- Move builder focus and editable outlines from `--ds-accent` to builder accent values so the studio remains visible across light and dark templates.

## CS-UI-002 - Content Studio motion and interaction feedback

Status: approved and implemented in canonical template

Request: Make modal opening and closing feel smooth, and add smooth feedback to active clickables.

Decision: Use short, restrained motion throughout the Content Studio UI.

- Menu and editing dock enter from 10px below with a subtle scale and fade.
- Inspector enters from 14px to the right with a subtle scale and fade.
- Closing animations complete before the panel receives `hidden`.
- Enabled buttons, tabs, switches, and the launcher receive coordinated hover, focus, and pressed feedback.
- Disabled actions remain static so their unavailable state stays clear.
- Respect `prefers-reduced-motion` and remove perceptible animation when requested by the operating system.
- Apply reduced-motion handling to nested hover-preview icons and close-label reveals as well as their parent controls.

Affected files:

- `src/builder/BuilderStyles.astro`
- `src/builder/BuilderClient.astro`

Replication notes:

- Copy both the transition styles and the `setPanelVisible` helper; exit motion depends on delaying the `hidden` attribute.
- Keep panel motion between 210–240ms and control feedback between 80–180ms.
- Apply hover elevation only inside `@media (hover: hover)` to avoid sticky hover states on touch devices.
- Never animate disabled actions.

## CS-UI-003 - Readable warm accent text

Status: approved and implemented in canonical template

Request: Bronze text inside the Content Studio dock is not readable enough on the teal modal surface.

Decision: Keep bronze/copper as trim, but use a lighter warm-gold text token for readable labels and status badges.

- Warm accent text: `#ffdca8`
- Strong warm accent text: `#ffebc8`
- Unsaved badge backgrounds remain subtle, but their labels use the stronger warm accent.
- Darker bronze remains useful for borders, switch thumb, and decorative edge treatments.

Affected file:

- `src/builder/BuilderStyles.astro`

Replication notes:

- Replace dark bronze text on teal surfaces with the readable warm accent token.
- Apply to dock eyebrow labels, unsaved status/count pills, active tabs, changes labels, SEO section headings, and draft comparison text.
- Do not use the brighter text token for borders or large filled shapes; keep those in the darker bronze/copper tokens.

## CS-UI-004 - Unsaved exit notice copy

Status: approved and implemented in canonical template

Request: Do not show an error when a user clicks Done before saving a draft; use the copy `Save this draft before closing edit mode.`

Decision: Treat this as a guarded unsaved state, not a failure.

- Keep the status pill as `Unsaved changes`.
- Show `Save this draft before closing edit mode.` as a warm inline notice in the editing dock.
- Hide the left status pill in the dock while this notice is visible, because the right unsaved-edit count already communicates the state.
- Style the notice as plain inline text with a warning triangle, not as a bordered card.
- Keep red/pink error styling only for real save, publish, or loading failures.

Affected files:

- `src/builder/BuilderClient.astro`
- `src/builder/BuilderStyles.astro`

Replication notes:

- Clicking Done with unsaved edits should call the unsaved state with the approved helper copy.
- The dock message area should support both `notice` and `error` tones.
- The notice tone should remove the card border/background and include a compact warning icon before the copy.
- Do not enable publish/review from this notice state; users must save the draft first.

## CS-UI-005 - Compact close controls

Status: approved and implemented in canonical template

Request: Close pills should show only a cross icon by default; on hover, add the border and reveal the `Close` text smoothly.

Decision: Make Content Studio close buttons compact by default and expandable on hover/focus.

- Main menu and inspector close buttons show only `×` at rest.
- Hover and keyboard focus expand the control to reveal `Close`.
- The border appears only in the expanded hover/focus state.
- The label remains in the DOM for accessible naming and smooth reveal.
- The close label must not inherit header pill styling; the expanded state should be a single outer pill, not a nested bubble.
- Expansion uses a gentler 260–280ms ease-out curve, with the label fade slightly delayed so the text follows the pill shape smoothly.
- Keep both the cross and `Close` label at a restrained medium weight, with the final label size set to `0.86rem` after the approved refinement.
- Reduce the close pill's vertical spacing by roughly half while keeping the collapsed control circular.
- Give the expanded pill 50% more horizontal breathing space than the compact version so the cross and label do not feel cramped.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderStyles.astro`

Replication notes:

- Wrap the close button label in a span so it can animate independently from the cross icon.
- Scope header pill styles to the locale/path pill only, otherwise they leak into the close label.
- Apply only to actual close controls, not `Details`, tabs, or action buttons.
- Keep keyboard focus behavior equivalent to hover so non-mouse users can discover the text label.
- Use delayed opacity on the label reveal instead of showing the text before the pill has room.

## CS-UI-006 - Launcher unpublished count badge

Status: approved and implemented in canonical template

Request: Replace the unpublished draft dot on the launcher with a visible count badge that slightly overflows from the top.

Decision: Use a compact absolute count badge on the launcher icon.

- Increase the launcher button and draggable shell from `48px` to `60px` for a 25% larger primary target.
- Show the current unpublished-change count when a saved draft exists.
- Use `Content editor` as the normal launcher hover label.
- Position the badge absolute at the launcher top-right, slightly overflowing the button.
- Use matching warm border and text colors with a lighter teal/warm background.
- Keep the badge circular for single digits and allow a compact pill only for multi-digit counts.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderStyles.astro`

Replication notes:

- Replace the old empty status dot with a count-bearing badge element.
- Replace the generic `Content Studio` launcher hover copy with `Content editor`.
- Keep the badge inside the launcher button for positioning, but offset it outside the icon corner.
- The hover label can be refined separately to match this count language.

## CS-UI-007 - Launcher hover preview summary

Status: approved and implemented in canonical template

Request: Try a richer launcher hover state with `Content editor` as the heading, a small unpublished summary when needed, and a show-more/open icon; also handle the no-change state thoughtfully.

Decision: Replace the simple hover pill with a compact two-line preview.

- Heading remains `Content editor`.
- No unpublished draft state shows `Edit this page`.
- Unpublished draft state shows the live count with singular/plural copy, such as `1 unpublished change` or `2 unpublished changes`.
- A small circular open arrow appears on the right as the action affordance.
- The full hover preview is clickable and opens Content Studio.
- Use a clean stroke-based north-east arrow instead of a font glyph so it stays optically centered.
- Lock the arrow chip to equal width and height so flex layout cannot compress it into an oval.
- The open arrow moves slightly up-right when the hover preview itself is hovered/focused; keep the circular chip itself steady.
- The hover preview uses a compact rounded rectangle, not a long single-line pill.
- Keep the full-width launcher wrapper pointer-transparent so empty space cannot trigger the preview.
- Limit hover activation to the launcher icon and visible preview, with only a narrow bridge between them for stable cursor travel.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderStyles.astro`

Replication notes:

- Keep the launcher icon itself as the primary click target; the hover preview is supporting context.
- Make the hover preview a real button for pointer and keyboard access.
- Keep the summary short enough to avoid a wide tooltip.
- Do not hide the summary on mobile; reduce typography and icon size instead.

## CS-UI-008 - Remove the editing context pill

Status: approved and implemented in canonical template

Request: Remove the floating field/locale pill that appears over page content when editing starts.

Decision: Remove the context pill completely and rely on the editing dock and inspector for field, locale, and entry context.

- Do not render the floating `field · locale · collection/entry` pill.
- Remove its client-side positioning and scroll-update work rather than retaining hidden markup.
- Keep the selected-field outline, editing dock title, and inspector details unchanged.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderClient.astro`
- `src/builder/BuilderStyles.astro`
- `tests/content-studio-ui-contract.test.mjs`

Replication notes:

- Remove the context-pill markup, selectors, and update helper together.
- Do not remove the editable-field outline or selected-field information in the editing dock and inspector.

## CS-UI-009 - Pencil edit launcher icon

Status: approved and implemented in canonical template

Request: Replace the Content Studio launcher sparkle with the supplied `PencilLine.svg` edit icon.

Decision: Inline the supplied pencil SVG geometry inside the launcher and inherit the approved builder text color.

- Render the pencil icon at `28px × 28px` inside the existing `60px × 60px` launcher.
- Use `currentColor` for both paths and preserve the source icon's subtle `0.2` opacity fill detail.
- Keep the SVG decorative with `aria-hidden="true"`; the launcher button's accessible label continues to name the action.
- Do not load the icon from an external path and do not restore the `✦` glyph.
- Keep launcher dragging, hover, active, count-badge, and focus behavior unchanged.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderStyles.astro`
- `tests/content-studio-ui-contract.test.mjs`

Replication notes:

- Copy the inline SVG paths from the canonical toolbar rather than depending on a local Downloads file.
- Copy `.builder-launcher-icon` sizing from the canonical styles.

## CS-FN-001 - Launcher toggles active editing closed

Status: approved and implemented in canonical template

Request: Prevent the Content Studio launcher from opening the main menu behind the editing dock; when editing is active, use the launcher to close it instead, but preserve the unsaved-edit warning.

Decision: Make the floating launcher use the same guarded close workflow as the editing dock's `Done` button.

- Close the main menu when edit mode begins.
- When edit mode or its editing dock is active, clicking the launcher icon attempts to close editing instead of opening another menu.
- Suppress the `Content editor / Edit this page` hover preview during active editing because it describes an action that is already active.
- If unsaved edits exist, keep editing open and show `Save this draft before closing edit mode.`
- If there are no unsaved edits, close the editing dock and inspector cleanly.
- Reuse one close handler for the launcher and `Done` so their behavior cannot drift apart.
- Keep the editing dock's `Details` action available for opening the active editing inspector.

Affected files:

- `src/builder/BuilderClient.astro`
- `src/builder/BuilderStyles.astro`

Replication notes:

- Route both the launcher and `Done` through the shared guarded close handler.
- A saved unpublished draft does not block closing; only currently unsaved edits do.

## CS-FN-002 - Live unpublished-change count

Status: approved and implemented in canonical template

Request: Update the launcher after save or publish without requiring a page refresh, and show the real number of unpublished changes instead of a hard-coded `1`.

Decision: Use the content-diff response as the client-side source of truth for launcher draft state.

- Keep the server-rendered draft flag as a stable initial fallback.
- After a successful diff request, update the launcher subtitle, count badge, local draft flag, and toolbar data attribute together.
- Keep publish/review availability and stable status text synchronized with the refreshed draft state when there are no local unsaved edits.
- Use correct singular/plural copy for the live count.
- Load the real count on initial page startup when the server reports an existing draft.
- Refresh the count after saving a draft through the existing diff reload.
- Clear the launcher state immediately after publishing.
- Preserve the existing fallback state if the diff request fails.
- Ignore superseded diff responses so an older request cannot restore a stale badge after a newer save or publish.
- Preserve active saving, publishing, and error states while a background diff response updates the launcher.

Affected files:

- `src/builder/BuilderToolbar.astro`
- `src/builder/BuilderClient.astro`
- `src/builder/BuilderStyles.astro`
- `tests/content-studio-ui-contract.test.mjs`

Replication notes:

- Render stable launcher summary and badge nodes even when no draft exists; toggle their content and visibility rather than relying on another server render.
- Keep the badge hidden with an explicit CSS rule because component display styles can otherwise override the HTML `hidden` behavior.
- Derive the count from the combined, de-duplicated review targets returned by the draft-diff endpoint.

## CS-FN-003 - Draggable launcher with bounded panels

Status: approved and implemented in canonical template

Request: Allow the fixed Content Studio launcher to be dragged to another location while ensuring its opened menu and editing dock never overflow the viewport.

Decision: Treat the launcher as a movable 60px viewport anchor and position its floating panels independently within safe screen margins.

- Drag the launcher with mouse, pen, or touch pointer input.
- Require at least 5px of movement before treating the gesture as a drag, preserving normal click-to-open behavior.
- Suppress the click generated after a completed drag so repositioning cannot accidentally open or close Content Studio.
- Suppress the launcher hover preview during a drag and keep it hidden after release until the pointer leaves the icon, preventing hover/focus from appearing stuck at the new position.
- Clear drag state if pointer capture is unexpectedly lost.
- Clamp the launcher to a 12px viewport margin.
- Persist its last position in local storage and restore it on the next page load.
- Re-clamp the stored position when the viewport is resized.
- Prefer opening panels above or below the launcher based on available room.
- Clamp panel left/top coordinates, cap panel height to the viewport, and allow internal vertical scrolling when necessary.
- Flip the hover preview to the launcher's right side when that side has more available room.
- Keep the existing inspector viewport-bounded independently.
- Measure floating panels from the always-present shell anchor so hiding the launcher during inspector mode cannot move the dock to the top-left.
- Keep the desktop editing dock exactly `20px` below the inspector while it is open, capping the dock height to the remaining viewport space when necessary.
- Reserve stacked inspector space only while the editing dock is visible; opening Page SEO or Changes without the dock keeps the inspector's normal height.

Affected files:

- `src/builder/BuilderClient.astro`
- `src/builder/BuilderStyles.astro`
- `tests/content-studio-ui-contract.test.mjs`

Replication notes:

- Keep the shell itself at the launcher footprint; a wide invisible shell recreates the oversized hover target.
- Position visible panels with fixed viewport coordinates derived from the launcher rectangle.
- Storage failures must not disable dragging; fall back to the CSS bottom-right position.
