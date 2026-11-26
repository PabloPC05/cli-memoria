import express, { type NextFunction, type Request, type Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TokenStore } from "./auth/tokens.js";
import type { ClientsService } from "./clients.js";
import type { Logger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";
import { createMcpServer } from "./tools.js";

/** Largest JSON body `/mcp` accepts: a `publish` of several long notes. */
export const MAX_MCP_BODY = "32mb";

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

/**
 * Whether the body starts a session. The `instructions` (the memory's rules file and the short index) are only
 * part of the answer to `initialize`: rendering them for every tool call would cost more than the call itself.
 */
export function wantsInitialize(body: unknown): boolean {
	const messages = Array.isArray(body) ? body : [body];
	return messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize");
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
		const instructions = wantsInitialize(req.body) ? await memory.instructions() : null;
		const server = await createMcpServer(memory, client, log, clients, instructions);
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
		if (res.headersSent) return;
		// A body over the limit is the client's mistake, not ours.
		if ((error as { type?: string })?.type === "entity.too.large") res.status(413).json({ error: "payload_too_large", limit: MAX_MCP_BODY });
		else res.status(500).json({ error: "internal_error" });
	};
}

/**
 * HTTP app: stateless MCP endpoint authenticated with per-client static Bearer tokens. There is no git remote and no
 * push webhook: this process is the only writer.
 */
export function createApp(opts: { memory: MemoryService; tokens: TokenStore; log: Logger; clients?: ClientsService | null }): express.Express {
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

	app.all("/mcp", authenticated, express.json({ limit: MAX_MCP_BODY }), asyncRoute(mcpHandler(opts.memory, opts.log, opts.clients ?? null)));
	app.use((_req, res) => {
		res.status(404).json({ error: "not_found" });
	});
	app.use(errorHandler(opts.log));
	return app;
}
