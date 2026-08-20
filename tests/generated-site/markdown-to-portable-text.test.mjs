import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/markdown-to-portable-text.mjs", import.meta.url));
const convert = (markdown) => spawnSync(process.execPath, [script], { input: markdown, encoding: "utf8" });
const spans = (blocks) => blocks.flatMap((block) => Array.isArray(block.children) ? block.children : []);

test("converts article Markdown to semantic Portable Text JSON", () => {
  const result = convert(`Opening paragraph.

## Main heading

### Subheading

- **Bold item**
- Plain item

1. First numbered item
2. Second numbered item

An _emphasized_ conclusion.`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const blocks = JSON.parse(result.stdout);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.find((block) => block.style === "h2").children[0].text, "Main heading");
  assert.equal(blocks.find((block) => block.style === "h3").children[0].text, "Subheading");
  assert.equal(blocks.filter((block) => block.listItem === "bullet").length, 2);
  assert.equal(blocks.filter((block) => block.listItem === "number").length, 2);
  assert.ok(spans(blocks).some((span) => span.marks?.includes("strong")));
  assert.ok(spans(blocks).some((span) => span.marks?.includes("em")));
  const visibleText = spans(blocks).map((span) => span.text).join("\n");
  assert.doesNotMatch(visibleText, /(?:^|\n)#{2,3}\s/);
  assert.doesNotMatch(visibleText, /\*\*[^*]+\*\*/);
  assert.doesNotMatch(visibleText, /(?:^|\n)(?:-|\d+\.)\s/);
});

test("rejects empty Markdown without emitting content JSON", () => {
  const result = convert(" \n\t ");
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Markdown input is required/);
});
