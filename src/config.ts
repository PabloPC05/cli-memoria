import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Level } from "./log.js";

export interface Listen {
	address: string;
	port: number;
}

export interface ServerConfig {
	dataDir: string;
	branch: string;
	authorDomain: string;
	listen: Listen;
	tokensFile: string | null;
	logLevel: Level;
	/** Keys of the file this version no longer uses (a git remote, the push webhook, file extraction…): ignored, but said in the log. */
	ignoredKeys: string[];
}

function str(v: unknown, key: string, fallback?: string): string {
	if (v === undefined && fallback !== undefined) return fallback;
	if (typeof v !== "string" || !v) throw new Error(`${key} must be a non-empty string`);
	return v;
}

function parseListen(v: unknown, key: string): Listen {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${key} must be a table with port`);
	const t = v as Record<string, unknown>;
	if (typeof t.port !== "number" || !Number.isInteger(t.port)) throw new Error(`${key}.port must be an integer`);
	return { address: str(t.address, `${key}.address`, "127.0.0.1"), port: t.port };
}

/**
 * Keys of the configuration that this server no longer uses: the git remote it cloned and fetched, the webhook that
 * told it to, and the extraction of attached files (pdftotext and OCR of scans and images). They are left in place in
 * existing files and only mentioned in the log: removing them from a working configuration must never make the
 * server refuse to start.
 */
const IGNORED_KEYS = ["remote", "fetch_interval_seconds", "webhook_secret_file", "pdftotext", "ocr"] as const;

export function loadConfig(file: string): ServerConfig {
	const base = resolve(file, "..");
	const doc = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
	const listenRaw = doc.listen as Record<string, unknown> | undefined;
	if (!listenRaw) throw new Error("configure [listen] with address and port");
	// Accept legacy [listen.private] so existing config files keep working during migration.
	const listen = listenRaw.port !== undefined ? parseListen(listenRaw, "listen") : listenRaw.private !== undefined ? parseListen(listenRaw.private, "listen.private") : parseListen(listenRaw, "listen");
	const dataDir = resolve(base, str(doc.data_dir, "data_dir", "/var/lib/cli-memoria"));
	return {
		dataDir,
		branch: str(doc.branch, "branch", "main"),
		authorDomain: str(doc.author_domain, "author_domain", "cli-memoria.invalid"),
		listen,
		tokensFile: doc.tokens_file === undefined ? null : resolve(base, str(doc.tokens_file, "tokens_file")),
		logLevel: (["debug", "info", "warn", "error"].includes(doc.log_level as string) ? doc.log_level : "info") as Level,
		ignoredKeys: IGNORED_KEYS.filter((key) => doc[key] !== undefined),
	};
}
