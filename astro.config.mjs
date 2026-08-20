import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

// EmDash MCP is enabled for build/preview/production so OpenHands can manage
// EmDash content through the Worker route. Keep it off in astro dev because the
// MCP route graph is Worker-only and can destabilize Vite SSR optimization.
const enableEmDashMcp = process.env.NODE_ENV !== "development";
const devOptimizerExcludes = [
	"emdash/middleware",
	"emdash/middleware/auth",
	"emdash/middleware/redirect",
	"emdash/middleware/request-context",
	"emdash/middleware/setup",
	"emdash/runtime",
	"emdash/media/local-runtime",
	"@emdash-cms/cloudflare/db/d1",
	"@emdash-cms/cloudflare/sandbox",
	"@emdash-cms/cloudflare/storage/r2",
	"astro/compiler-runtime",
	"astro/zod",
];
const cloudflareNativeModuleAliases = [
	{
		find: "better-sqlite3",
		replacement: new URL(
			"./src/server/shims/better-sqlite3.ts",
			import.meta.url,
		).pathname,
	},
];

function isKnownEmDashCreateRequireWarning(warning) {
	const message = String(warning?.message ?? "");
	return (
		warning?.code === "UNUSED_EXTERNAL_IMPORT" &&
		(warning.exporter === "node:module" || message.includes("node:module")) &&
		((Array.isArray(warning.names) && warning.names.includes("createRequire")) ||
			message.includes("createRequire")) &&
		((typeof warning.id === "string" &&
			warning.id.includes("node_modules/emdash")) ||
			message.includes("node_modules/emdash"))
	);
}

export default defineConfig({
	output: "server",
	adapter: cloudflare({
		sessionKVBindingName: "SESSION",
		imageService: "cloudflare-binding",
		imagesBindingName: "IMAGES",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "disabled" }),
			storage: r2({ binding: "MEDIA" }),
			mcp: enableEmDashMcp,
			fonts: false,
		}),
	],
	vite: {
		build: {
			// The generated-site Worker includes Astro, EmDash admin/MCP, and the
			// Cloudflare adapter in one server bundle. Keep this threshold explicit
			// so real warnings still surface without noisy false positives.
			chunkSizeWarningLimit: 3000,
			rollupOptions: {
				onLog(level, log, handler) {
					if (level === "warn" && isKnownEmDashCreateRequireWarning(log)) {
						return;
					}
					handler(level, log);
				},
				onwarn(warning, warn) {
					if (isKnownEmDashCreateRequireWarning(warning)) {
						return;
					}
					warn(warning);
				},
			},
		},
		resolve: {
			alias: cloudflareNativeModuleAliases,
		},
		server: {
			allowedHosts: ["7e44-223-181-57-33.ngrok-free.app",
				"peristomial-johnnie-unprosaically.ngrok-free.dev"
			],
		},
		optimizeDeps: {
			include: ["tz-lookup"],
			exclude: devOptimizerExcludes,
		},
	},
	devToolbar: { enabled: false },
});
