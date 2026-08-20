import { env } from "cloudflare:workers";

export const prerender = false;

const DEFAULT_SCOPES = [
	"content:read",
	"content:write",
	"media:read",
	"media:write",
	"schema:read",
	"schema:write",
	"taxonomies:manage",
	"menus:manage",
	"settings:read",
];

const feature = "astropages.openhands-mcp-token";
const systemUserEmail = "openhands-mcp@astropages.internal";
const systemUserName = "AstroPages OpenHands MCP";
const adminRole = 50;
const defaultTokenName = "AstroPages OpenHands MCP";

type D1StatementWithFirst = {
	bind(...values: unknown[]): D1StatementWithFirst;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
};

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const error = (message: string, status = 400) =>
	json({ status: "error", state: "error", feature, message }, status);

const success = (data: Record<string, unknown>) =>
	json({ status: "ready", state: "ready", feature, ...data });

const base64Url = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const hashToken = async (value: string) => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base64Url(new Uint8Array(digest));
};

const tokenPrefix = (token: string) => token.slice(0, "ec_pat_".length + 4);

const isSafeToken = (value: string) => value.startsWith("ec_pat_") && value.length >= 24;

const readBearerToken = (request: Request) => {
	const authorization = request.headers.get("Authorization") || "";
	const [scheme, token] = authorization.split(" ");
	return scheme?.toLowerCase() === "bearer" && token ? token : "";
};

const emdashDbFromEnv = (runtimeEnv: Record<string, unknown>) => {
	for (const name of ["DB", "EMDASH_DB", "ASTROPAGES_DB", "DATABASE"]) {
		const candidate = runtimeEnv[name] as { prepare?: unknown } | undefined;
		if (candidate && typeof candidate.prepare === "function") {
			return candidate as {
				prepare: (query: string) => {
					bind: (...values: unknown[]) => {
						first: <T>() => Promise<T | null>;
						run: () => Promise<unknown>;
					};
				};
			};
		}
	}
	return null;
};

const prepare = (db: NonNullable<ReturnType<typeof emdashDbFromEnv>>, sql: string) =>
	db.prepare(sql) as unknown as D1StatementWithFirst;

const normalizeScopes = (value: unknown) =>
	Array.isArray(value) && value.every((scope) => typeof scope === "string" && scope.trim())
		? value.map((scope) => scope.trim())
		: DEFAULT_SCOPES;

const insertServiceUser = async (
	db: NonNullable<ReturnType<typeof emdashDbFromEnv>>,
	input: { id: string; email: string; name: string; now: string },
) => {
	await prepare(
		db,
		"INSERT INTO users (id, email, name, avatar_url, role, email_verified, data, disabled, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 1, NULL, 0, ?, ?)",
	)
		.bind(input.id, input.email, input.name, adminRole, input.now, input.now)
		.run();
};

const ensureSystemUser = async (
	db: NonNullable<ReturnType<typeof emdashDbFromEnv>>,
	now: string,
) => {
	const existing = await prepare(db, "SELECT id FROM users WHERE email = ? LIMIT 1")
		.bind(systemUserEmail)
		.first<{ id?: unknown }>();

	if (existing && typeof existing.id === "string") {
		await prepare(
			db,
			"UPDATE users SET name = ?, role = ?, email_verified = 1, disabled = 0, updated_at = ? WHERE id = ?",
		)
			.bind(systemUserName, adminRole, now, existing.id)
			.run();
		return existing.id;
	}

	const id = crypto.randomUUID();
	await insertServiceUser(db, { id, email: systemUserEmail, name: systemUserName, now });
	return id;
};

export async function POST({ request }: { request: Request }) {
	const runtimeEnv = env as Record<string, unknown>;
	const expectedToken =
		typeof runtimeEnv.SERVICE_CALLBACK_BEARER_TOKEN === "string"
			? runtimeEnv.SERVICE_CALLBACK_BEARER_TOKEN
			: typeof runtimeEnv.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN === "string"
				? runtimeEnv.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN
				: "";
	const providedToken = readBearerToken(request);
	if (!expectedToken && providedToken) {
		return error("service callback token is not configured", 500);
	}
	if (!expectedToken || providedToken !== expectedToken) {
		return error("unauthorized", 401);
	}

	const db = emdashDbFromEnv(runtimeEnv);
	if (!db) {
		return error("emdash_d1_binding_missing", 500);
	}

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	if (body.dryRun === true) {
		try {
			await prepare(db, "SELECT id FROM users LIMIT 1").first();
			await prepare(db, "SELECT id FROM _emdash_api_tokens LIMIT 1").first();
			return success({
				message: "EmDash MCP token bootstrap dry-run passed.",
				data: { dryRun: true },
			});
		} catch (dryRunError) {
			const message = dryRunError instanceof Error ? dryRunError.message : "EmDash MCP dry-run failed.";
			return error(message, 500);
		}
	}

	const token = typeof body.token === "string" ? body.token.trim() : "";
	if (!isSafeToken(token)) {
		return error("token must be an ec_pat_ token value", 400);
	}

	const scopes = normalizeScopes(body.scopes);
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : defaultTokenName;
	const now = new Date().toISOString();

	try {
		const userId = await ensureSystemUser(db, now);
		const tokenHash = await hashToken(token);
		const existingToken = await prepare(
			db,
			"SELECT id FROM _emdash_api_tokens WHERE token_hash = ? OR (name = ? AND user_id = ?) LIMIT 1",
		)
			.bind(tokenHash, name, userId)
			.first<{ id?: unknown }>();
		const existingTokenId = existingToken && typeof existingToken.id === "string" ? existingToken.id : undefined;

		if (existingTokenId) {
			await prepare(
				db,
				"UPDATE _emdash_api_tokens SET name = ?, token_hash = ?, prefix = ?, user_id = ?, scopes = ?, expires_at = NULL WHERE id = ?",
			)
				.bind(name, tokenHash, tokenPrefix(token), userId, JSON.stringify(scopes), existingTokenId)
				.run();
		} else {
			await prepare(
				db,
				"INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
			)
				.bind(crypto.randomUUID(), name, tokenHash, tokenPrefix(token), userId, JSON.stringify(scopes), now)
				.run();
		}

		return success({
			message: "EmDash MCP token provisioned.",
			data: {
				mcpUrl: "/_emdash/api/mcp",
				scopes,
				tokenPrefix: tokenPrefix(token),
				userId,
			},
		});
	} catch (provisionError) {
		const message = provisionError instanceof Error ? provisionError.message : "Failed to provision EmDash MCP token.";
		return error(message, 500);
	}
}
