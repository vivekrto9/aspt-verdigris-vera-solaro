import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const builderClient = read("../src/builder/BuilderClient.astro");
const builderStyles = read("../src/builder/BuilderStyles.astro");
const builderToolbar = read("../src/builder/BuilderToolbar.astro");

test("inline Studio edits become dirty without rendering a redundant context pill", () => {
  assert.match(builderClient, /const clearPendingChange = \(field, target = defaultTarget\(\)\) =>/);
  assert.ok(
    builderClient.match(/element\.addEventListener\("input", handleInput\);/g)?.length >= 2,
    "text and placeholder editors should both track input events",
  );
  assert.doesNotMatch(builderToolbar, /data-builder-context-chip/);
  assert.doesNotMatch(builderClient, /updateContextChip|contextChip|chipField|chipMeta/);
  assert.doesNotMatch(builderStyles, /\.builder-context-chip/);
});

test("Studio launcher keeps a compact fixed footprint", () => {
  assert.match(
    builderStyles,
    /\.builder-launcher-button\s*\{[^}]*width:\s*60px;[^}]*height:\s*60px;/s,
  );
  assert.match(builderToolbar, /data-builder-launcher-icon/);
  assert.match(builderStyles, /\.builder-launcher-icon\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
  assert.doesNotMatch(builderToolbar, />✦</);
  assert.match(builderStyles, /\.builder-launcher-wrap\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(builderStyles, /\.builder-launcher-label::after\s*\{[^}]*right:\s*-12px;[^}]*width:\s*12px;/s);
});

test("Studio enabled controls remain distinct from modal surfaces", () => {
  assert.match(builderStyles, /--builder-control-top:\s*#285e59;/);
  assert.match(builderStyles, /--builder-control-bottom:\s*#1d4f4a;/);
  assert.match(
    builderStyles,
    /\.builder-action\s*\{[^}]*background:\s*linear-gradient\(180deg, var\(--builder-control-top\) 0%, var\(--builder-control-bottom\) 100%\);/s,
  );
  assert.match(
    builderStyles,
    /\.builder-action:disabled\s*\{[^}]*background:\s*rgba\(12, 53, 49, 0\.22\);[^}]*box-shadow:\s*none;[^}]*color:\s*rgba\(255, 248, 234, 0\.34\);/s,
  );
});

test("Studio launcher synchronizes its unpublished count without a refresh", () => {
  assert.match(builderToolbar, /data-builder-launcher-summary/);
  assert.match(builderToolbar, /data-builder-draft-count/);
  assert.match(builderClient, /const updateLauncherDraftState = \(count\) =>/);
  assert.match(builderClient, /updateLauncherDraftState\(draftChanges\.length\);/);
  assert.match(builderClient, /if \(hasSavedDraft\) loadDraftChanges\(\);/);
  assert.match(builderClient, /if \(loadVersion !== draftLoadVersion\) return;/);
  assert.match(builderClient, /launcherDraftCount\.toggleAttribute\("data-builder-multi-digit", draftCount > 9\)/);
  assert.match(builderStyles, /\[data-builder-draft-count\]\[hidden\]/);
  assert.match(builderStyles, /i\[data-builder-multi-digit\]/);
});

test("Studio launcher can be dragged without allowing panels to overflow the viewport", () => {
  assert.match(builderClient, /launcher\?\.addEventListener\("pointerdown"/);
  assert.match(builderClient, /Math\.hypot\(deltaX, deltaY\) < 5/);
  assert.match(builderClient, /suppressLauncherClick = true/);
  assert.match(builderClient, /toolbar\.setAttribute\("data-builder-preview-suppressed", ""\)/);
  assert.match(builderClient, /launcher\.blur\(\)/);
  assert.match(builderClient, /launcher\?\.addEventListener\("lostpointercapture", finishLauncherDrag\)/);
  assert.match(builderClient, /launcher\?\.addEventListener\("pointerleave", clearLauncherDragPreviewSuppression\)/);
  assert.match(builderClient, /window\.localStorage\.setItem\(launcherPositionKey/);
  assert.match(builderClient, /const positionFloatingPanel = \(element\) =>/);
  assert.match(builderClient, /const launcherRect = toolbar\.getBoundingClientRect\(\)/);
  assert.match(builderClient, /let left = clamp\(launcherRect\.right - panelWidth, viewportMargin, maximumLeft\)/);
  assert.match(builderClient, /let top = clamp\(preferredTop, viewportMargin, maximumTop\)/);
  assert.match(builderClient, /element === editingDock && inspector && !inspector\.hidden && window\.innerWidth >= 980/);
  assert.match(builderClient, /const stackedModalGap = 20/);
  assert.match(builderClient, /viewportHeight - inspectorRect\.bottom - stackedModalGap - viewportMargin/);
  assert.match(builderClient, /inspectorRect\.bottom \+ stackedModalGap/);
  assert.match(builderClient, /toolbar\.toggleAttribute\("data-builder-label-right", roomOnRight > roomOnLeft\)/);
  assert.match(builderStyles, /\.builder-shell\s*\{[^}]*width:\s*60px;[^}]*height:\s*60px;/s);
  assert.match(
    builderStyles,
    /\.builder-shell\[data-builder-inspector-open\]:has\(\.builder-editing-dock:not\(\[hidden\]\)\) ~ \.builder-inspector/,
  );
  assert.match(builderStyles, /\.builder-shell\[data-builder-label-right\] \.builder-launcher-label/);
  assert.match(builderStyles, /touch-action:\s*none;/);
  assert.match(builderStyles, /\.builder-shell\[data-builder-preview-suppressed\] \.builder-launcher-label/);
  assert.match(builderStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.builder-launcher-label i svg/);
});

test("Studio live draft state keeps actions and status synchronized", () => {
  assert.match(builderClient, /if \(dirtyTotal\(\) === 0\) \{/);
  assert.match(builderClient, /setPublishEnabled\(hasSavedDraft\);/);
  assert.match(builderClient, /setReviewEnabled\(hasSavedDraft\);/);
  assert.match(builderClient, /setStatus\(hasSavedDraft \? "draft" : "idle"\);/);
});

test("Studio launcher closes any active editing dock instead of stacking the menu", () => {
  assert.match(builderClient, /const panelIsOpen = \(element\) =>/);
  assert.match(builderClient, /if \(editMode \|\| panelIsOpen\(editingDock\)\) \{/);
  assert.match(builderClient, /finishEditing\(\);/);
});
