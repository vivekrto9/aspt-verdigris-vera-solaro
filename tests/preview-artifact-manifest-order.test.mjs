import assert from "node:assert/strict";
import test from "node:test";
import { previewArtifactBuildIntegration } from "../scripts/preview-artifact-build.mjs";

test("asset discovery order produces identical serialized manifests without losing paths", () => {
  const assets = [
    "/_astro/BaseLayout.astro_astro_type_script_index_0_lang.D5dBEsF5.js",
    "/_astro/PlaceAutocomplete.astro_astro_type_script_index_0_lang.B-lb7KDL.js",
    "/images/product-lamp-hero.png",
  ];
  const normalize = previewArtifactBuildIntegration("/template").hooks["astro:build:ssr"];
  const first = { key: "first-build-key", assets: [...assets], routes: [{ route: "/z" }, { route: "/a" }] };
  const second = { ...structuredClone(first), key: "second-build-key", assets: [assets[2], assets[0], assets[1]] };
  normalize({ manifest: first });
  normalize({ manifest: second });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.assets, [...assets].sort());
  assert.deepEqual([...new Set(first.assets)].sort(), [...assets].sort());
  assert.deepEqual(first.routes, [{ route: "/z" }, { route: "/a" }]);
  const serialized = JSON.stringify(first);
  normalize({ manifest: first });
  assert.equal(JSON.stringify(first), serialized);
});

test("malformed asset inventories fail closed", () => {
  const normalize = previewArtifactBuildIntegration("/template").hooks["astro:build:ssr"];
  for (const assets of [null, {}, ["/valid", 42]])
    assert.throws(() => normalize({ manifest: { key: "generated", assets } }), /preview_artifact_astro_manifest_shape_changed/);
});
