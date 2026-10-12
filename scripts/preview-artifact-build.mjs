import { fileURLToPath } from "node:url";

/** Executed in the tenant isolate; the serialized artifact never supplies a key. */
export function withPreviewArtifactRuntime(manifest, env) {
  const key = env.ASTROPAGES_PREVIEW_ASTRO_KEY;
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    atob(key).length !== 32
  )
    throw new Error("preview_artifact_runtime_key_required");
  return { ...manifest, key };
}

export function normalizeGeneratedMetadata(code, root, context) {
  if (!context?.metadata || !context.id.endsWith(".astro")) return code;
  if (context.metadata.serverComponents?.length)
    throw new Error("preview_artifact_server_islands_require_requalification");
  const tree = context.parse(code);
  const aliases = new Map();
  const edits = new Map();
  for (const node of tree.body)
    if (
      node.type === "ImportDeclaration" &&
      node.source.value === "astro/compiler-runtime"
    ) {
      for (const specifier of node.specifiers)
        if (specifier.type === "ImportSpecifier")
          aliases.set(specifier.imported.name, specifier.local.name);
    }
  const isCall = (node, name) =>
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === aliases.get(name);
  const replace = (node) => {
    if (
      node?.type === "Literal" &&
      typeof node.value === "string" &&
      node.value.startsWith(root + "/")
    ) {
      edits.set(node.start, {
        end: node.end,
        text: JSON.stringify(
          "/workspace/template" + node.value.slice(root.length),
        ),
      });
    }
  };
  const exported = tree.body.find(
    (node) => node.type === "ExportDefaultDeclaration",
  )?.declaration;
  const component =
    exported?.type === "Identifier"
      ? tree.body
          .flatMap((node) =>
            node.type === "VariableDeclaration" ? node.declarations : [],
          )
          .find((node) => node.id.name === exported.name)?.init
      : exported;
  if (
    !isCall(component, "createComponent") ||
    component.arguments[1]?.value !== context.id
  )
    throw new Error("preview_artifact_astro_component_shape_changed");
  replace(component.arguments[1]);
  const fileExport = tree.body.some(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.specifiers.some(
        (specifier) =>
          specifier.local.name === "$$file" &&
          specifier.exported.name === "file",
      ),
  );
  if (fileExport)
    for (const node of tree.body.flatMap((node) =>
      node.type === "VariableDeclaration" ? node.declarations : [],
    ))
      if (node.id.name === "$$file" && node.init?.value === context.id)
        replace(node.init);
  const paths = new Set(
    [
      ...(context.metadata.clientOnlyComponents ?? []),
      ...(context.metadata.hydratedComponents ?? []),
    ].map((component) => component.resolvedPath),
  );
  const scripts = new Set(
    (context.metadata.scripts ?? []).map(
      (_script, index) =>
        `${context.id}?astro&type=script&index=${index}&lang.ts`,
    ),
  );
  const walk = (
    node,
    inRender = false,
    resultName = component.arguments[0]?.params?.[0]?.name,
  ) => {
    if (!node || typeof node !== "object") return;
    // Authored closures can shadow compiler bindings; never descend into them.
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    )
      return;
    const rendering =
      inRender ||
      isCall(node, "render") ||
      (node.type === "TaggedTemplateExpression" &&
        node.tag.type === "Identifier" &&
        node.tag.name === aliases.get("render"));
    const ownsResult =
      node.type === "CallExpression" &&
      node.arguments[0]?.type === "Identifier" &&
      node.arguments[0].name === resultName;
    if (
      rendering &&
      ownsResult &&
      isCall(node, "renderScript") &&
      scripts.has(node.arguments[1]?.value)
    )
      replace(node.arguments[1]);
    if (
      rendering &&
      ownsResult &&
      isCall(node, "renderComponent") &&
      node.arguments[3]?.type === "ObjectExpression"
    ) {
      const props = node.arguments[3].properties;
      const property = (name) =>
        props.find(
          (prop) =>
            prop.type === "Property" &&
            !prop.computed &&
            (prop.key.value ?? prop.key.name) === name,
        )?.value;
      const path = property("client:component-path");
      if (property("client:component-hydration") && paths.has(path?.value))
        replace(path);
    }
    if (
      rendering &&
      ownsResult &&
      isCall(node, "renderComponent") &&
      node.arguments[4]?.type === "ObjectExpression"
    ) {
      for (const slot of node.arguments[4].properties) {
        const value =
          slot.type === "Property" && !slot.computed ? slot.value : null;
        const compilerParameters =
          value?.type === "ArrowFunctionExpression" &&
          (value.params.length === 0 ||
            (value.params.length === 1 &&
              value.params[0].type === "Identifier" &&
              /^\$\$result\d*$/.test(value.params[0].name)));
        if (
          compilerParameters &&
          (isCall(value.body, "render") ||
            (value.body.type === "TaggedTemplateExpression" &&
              value.body.tag.name === aliases.get("render")))
        )
          walk(value.body, true, value.params[0]?.name ?? resultName);
      }
    }
    for (const value of Object.values(node))
      if (Array.isArray(value))
        value.forEach((child) => walk(child, rendering, resultName));
      else if (value && typeof value === "object")
        walk(value, rendering, resultName);
  };
  walk(component.arguments[0]?.body);
  return [...edits]
    .sort(([left], [right]) => right - left)
    .reduce(
      (result, [start, { end, text }]) =>
        result.slice(0, start) + text + result.slice(end),
      code,
    );
}

export function previewArtifactBuildIntegration(
  root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
) {
  const normalize = (value) =>
    typeof value === "string" && value.startsWith(root + "/")
      ? "/workspace/template" + value.slice(root.length)
      : typeof value === "string" && value.startsWith("file://" + root + "/")
        ? "file:///workspace/template" + value.slice(("file://" + root).length)
        : value;
  const plugin = {
    name: "aspect-preview-artifact-metadata",
    enforce: "post",
    transform(code, id) {
      const metadata = this.getModuleInfo?.(id)?.meta?.astro;
      if (metadata && id.endsWith(".astro"))
        return {
          code: normalizeGeneratedMetadata(code, root, {
            id,
            metadata,
            parse: (code) => this.parse(code),
          }),
          map: null,
        };
      if (id !== "\0virtual:astro:manifest") return;
      if (!code.includes("@@ASTRO_MANIFEST_REPLACE@@")) return;
      const target = "_deserializeManifest(('@@ASTRO_MANIFEST_REPLACE@@'))";
      if (!code.includes(target))
        throw new Error("preview_artifact_astro_manifest_shape_changed");
      const prerender = this.environment?.name === "prerender";
      // Prerender's build-local key is generated in memory, not serialized into
      // output. The serving SSR environment exclusively requires tenant binding.
      const env = prerender
        ? `{ASTROPAGES_PREVIEW_ASTRO_KEY:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`
        : "__previewArtifactEnv";
      return {
        code: `${prerender ? "" : "import {env as __previewArtifactEnv} from 'cloudflare:workers';\n"}${withPreviewArtifactRuntime.toString()}\n${code.replace(target, `_deserializeManifest(withPreviewArtifactRuntime(('@@ASTRO_MANIFEST_REPLACE@@'),${env}))`)}`,
        map: null,
      };
    },
  };
  return {
    name: "aspect-preview-artifact-build",
    hooks: {
      "astro:config:setup": ({ updateConfig }) =>
        updateConfig({ vite: { plugins: [plugin] } }),
      "astro:build:ssr": ({ manifest }) => {
        if (typeof manifest.key !== "string")
          throw new Error("preview_artifact_astro_manifest_shape_changed");
        manifest.key = "";
        for (const key of [
          "rootDir",
          "srcDir",
          "publicDir",
          "outDir",
          "cacheDir",
          "buildClientDir",
          "buildServerDir",
        ])
          if (key in manifest) manifest[key] = normalize(manifest[key]);
        for (const key of ["componentMetadata", "inlinedScripts"])
          if (Array.isArray(manifest[key]))
            manifest[key] = manifest[key].map(([id, value]) => [
              normalize(id),
              value,
            ]);
        if (manifest.entryModules)
          manifest.entryModules = Object.fromEntries(
            Object.entries(manifest.entryModules).map(([key, value]) => [
              normalize(key),
              value,
            ]),
          );
        for (const route of manifest.routes ?? [])
          if (route.file) route.file = normalize(route.file);
      },
    },
  };
}
