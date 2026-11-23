import { createHmac } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TokenStore } from "./auth/tokens.js";
import type { ClientsService } from "./clients.js";
import type { Logger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";
import { createMcpServer } from "./tools.js";
import type { UploadStore } from "./uploads.js";
import { safeEqual } from "./util.js";

type AuthedRequest = Request & { auth?: AuthInfo };

/** Who is calling, from the validated static token. */
export function identityFrom(req: AuthedRequest): ClientIdentity {
	const auth = req.auth as AuthInfo;
	const extra = (auth.extra ?? {}) as Record<string, string>;
	const session = req.header("x-memory-session")?.slice(0, 200) ?? null;
	return { id: auth.clientId, name: extra.name ?? auth.clientId, scope: auth.scopes.includes("write") ? "write" : "read", session };
}

/** Names of the tools called in a JSON-RPC body (one message or a batch); null entries for other requests. */
export function toolCalls(body: unknown): (string | null)[] {
	const messages = Array.isArray(body) ? body : [body];
	return messages
		.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as { method?: unknown }).method === "string")
		.map((m) => {
			const name = (m.params as { name?: unknown } | undefined)?.name;
			return m.method === "tools/call" && typeof name === "string" ? name.slice(0, 64) : null;
		});
}

function mcpHandler(memory: MemoryService, log: Logger, clients: ClientsService | null) {
	return async (req: Request, res: Response) => {
		if (req.method !== "POST") {
			res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null });
			return;
		}
		const client = identityFrom(req);
		if (clients) {
			try {
				for (const tool of toolCalls(req.body)) clients.record(client, tool);
			} catch (error) {
				log("warn", "clients.record_failed", { error: String(error) });
			}
		}
		const server = await createMcpServer(memory, client, log, clients);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			transport.close().catch(() => undefined);
			server.close().catch(() => undefined);
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	};
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
	return (req: Request, res: Response, next: NextFunction) => {
		fn(req, res).catch(next);
	};
}

function errorHandler(log: Logger) {
	return (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		log("error", "http.error", { error: String((error as Error)?.stack ?? error) });
		if (!res.headersSent) res.status(500).json({ error: "internal_error" });
	};
}

/**
 * HTTP app: stateless MCP endpoint authenticated with per-client static Bearer tokens,
 * streaming uploads (`PUT /uploads/:filename`) and an optional git push webhook (`POST /hooks/git`).
 */
export function createApp(opts: { memory: MemoryService; tokens: TokenStore; uploads: UploadStore; webhookSecret?: string | null; log: Logger; clients?: ClientsService | null }): express.Express {
	const app = express();
	app.disable("x-powered-by");

	const authenticate = (req: AuthedRequest, res: Response): boolean => {
		const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
		if (m?.[1]) {
			const token = m[1].trim();
			const stat = opts.tokens.verify(token);
			if (stat) {
				req.auth = { token, clientId: stat.id, scopes: [stat.scope], extra: { name: stat.name } };
				return true;
			}
		}
		opts.log("warn", "auth.rejected", { path: req.path });
		res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
		return false;
	};
	const authenticated = (req: Request, res: Response, next: NextFunction) => {
		if (authenticate(req, res)) next();
	};

	app.post("/hooks/git", express.raw({ type: "*/*", limit: "10mb" }), (req, res) => {
		if (!opts.webhookSecret) {
			res.status(404).end();
			return;
		}
		const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
		const rawSig = (req.header("x-hub-signature-256") ?? req.header("x-webhook-signature") ?? "").trim().toLowerCase();
		const given = rawSig.startsWith("sha256=") ? rawSig.slice("sha256=".length) : rawSig;
		const expected = createHmac("sha256", opts.webhookSecret).update(body).digest("hex");
		if (!given || !safeEqual(given, expected)) {
			opts.log("warn", "webhook.bad_signature", {});
			res.status(401).end();
			return;
		}
		opts.memory.requestSync("webhook");
		res.status(204).end();
	});

	app.put(
		"/uploads/:filename",
		authenticated,
		asyncRoute(async (req, res) => {
			const client = identityFrom(req);
			if (client.scope !== "write") {
				res.status(403).json({ error: "forbidden", message: "This client has read-only access." });
				return;
			}
			const filename = String(req.params.filename ?? "");
			if (!/^[^/\\\0]{1,255}$/.test(filename) || filename.startsWith(".")) {
				res.status(400).json({ error: "invalid_filename" });
				return;
			}
			const declared = req.header("content-length") ? Number(req.header("content-length")) : null;
			if (!(await opts.uploads.hasRoomFor(declared))) {
				res.status(507).json({ error: "insufficient_storage" });
				return;
			}
			const started = Date.now();
			const meta = await opts.uploads.receive(req, filename, client.id);
			opts.log("info", "upload", { client: client.id, size: meta.size, ms: Date.now() - started });
			res.status(201).json({ upload_id: meta.id, size: meta.size, sha256: meta.sha256 });
		}),
	);

	app.all("/mcp", authenticated, express.json({ limit: "512mb" }), asyncRoute(mcpHandler(opts.memory, opts.log, opts.clients ?? null)));
	app.use((_req, res) => {
		res.status(404).json({ error: "not_found" });
	});
	app.use(errorHandler(opts.log));
	return app;
}
