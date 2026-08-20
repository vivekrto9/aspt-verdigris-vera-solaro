export default class BetterSqlite3Unavailable {
	constructor() {
		throw new Error("better-sqlite3 is not available in the Cloudflare D1 runtime.");
	}
}
