import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToken, TokenStore } from "../src/auth/tokens.js";
import { createApp, MAX_MCP_BODY } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { UploadStore } from "../src/uploads.js";
import { makeMemory, note } from "./helpers.js";
import { makePdf } from "./pdf.js";

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
	});
}

let env: Awaited<ReturnType<typeof makeMemory>>;
let srv: { server: Server; url: string };
let writeToken: string;
let readToken: string;

beforeAll(async () => {
	env = await makeMemory({ "yo/perfil.md": note("Perfil", "Quién es", "Le gusta el café.") });
	const tokensFile = join(env.root, "tokens.toml");
	writeToken = await addToken(tokensFile, "claude-surface", "Claude Code (Surface)", "write");
	readToken = await addToken(tokensFile, "omb-lector", "Bot lector", "read");
	const tokens = new TokenStore(tokensFile);
	const uploads = new UploadStore(join(env.root, "data", "uploads"));
	await uploads.init();
	(env.memory.opts as { uploads: UploadStore }).uploads = uploads;
	srv = await listen(createApp({ memory: env.memory, tokens, uploads, log: silentLogger }));
});

afterAll(async () => {
	await new Promise((r) => srv?.server.close(r));
	await env?.cleanup();
});

async function mcp(url: string, token: string, session?: string): Promise<Client> {
	const client = new Client({ name: "test", version: "1" });
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (session) headers["x-memory-session"] = session;
	await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
	return client;
}

function parse(result: unknown): Record<string, unknown> {
	const r = result as { content: { text: string }[]; isError?: boolean };
	return { ...(JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>), ...(r.isError ? { isError: true } : {}) };
}

describe("HTTP server", () => {
	it("serves MCP with static tokens: instructions, tools by scope, attributed writes", async () => {
		const client = await mcp(srv.url, writeToken, "chat-7");
		expect(client.getInstructions()).toContain("[[perfil]]");
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(["attach", "create", "deadlines", "delete", "edit", "history", "links", "lint", "list", "move", "publish", "read", "recent", "revert", "search", "write"]);
		const created = parse(await client.callTool({ name: "create", arguments: { path: "personas/sara.md", content: note("Sara", "Amiga", "Le gusta el té."), reason: "Nueva" } }));
		expect(created.commit).toBeTruthy();
		const hist = parse(await client.callTool({ name: "history", arguments: { name: "sara" } })) as { commits: { author: string; trailers: Record<string, string> }[] };
		expect(hist.commits[0]?.author).toBe("Claude Code (Surface)");
		expect(hist.commits[0]?.trailers).toMatchObject({ Client: "claude-surface", Tool: "create", Session: "chat-7" });
		const recent = parse(await client.callTool({ name: "recent", arguments: { limit: 1 } })) as { commits: { commit: string; client: string; tool: string; notes: unknown[] }[] };
		expect(recent.commits[0]).toMatchObject({ commit: created.commit, client: "claude-surface", tool: "create", notes: [{ path: "personas/sara.md", name: "sara", change: "added" }] });
		const undone = parse(await client.callTool({ name: "revert", arguments: { commit: created.commit, reason: "Deshacer" } }));
		expect(undone).toMatchObject({ reverted: created.commit, changes: [{ path: "personas/sara.md", change: "removed" }] });
		const published = parse(
			await client.callTool({ name: "publish", arguments: { commits: [{ reason: "Llega Luis", changes: [{ op: "create", path: "personas/luis.md", content: note("Luis", "Compañero", "Juega al ajedrez.") }] }] } }),
		) as { commits: { reason: string }[]; hashes: Record<string, string> };
		expect(published.commits.map((c) => c.reason)).toEqual(["Llega Luis"]);
		expect(Object.keys(published.hashes)).toEqual(["personas/luis.md"]);
		const err = parse(await client.callTool({ name: "read", arguments: { name: "nadie" } }));
		expect(err).toMatchObject({ isError: true, code: "NOT_FOUND" });
		await client.close();
	});

	it("gives read-only tokens only the read tools", async () => {
		const client = await mcp(srv.url, readToken);
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(["deadlines", "history", "links", "lint", "list", "read", "recent", "search"]);
		const hits = parse(await client.callTool({ name: "search", arguments: { query: "café" } })) as { hits: { path: string }[] };
		expect(hits.hits[0]?.path).toBe("yo/perfil.md");
		const lint = parse(await client.callTool({ name: "lint", arguments: { kinds: ["stale", "oversized"] } }));
		expect(lint).toMatchObject({ counts: { stale: 0, oversized: 0 }, items: [] });
		const bad = (await client.callTool({ name: "lint", arguments: { kinds: ["nope"] } })) as { isError?: boolean };
		expect(bad.isError).toBe(true);
		await client.close();
	});

	it("rejects missing or unknown tokens", async () => {
		const r = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
		expect(r.status).toBe(401);
		const r2 = await fetch(`${srv.url}/mcp`, { method: "POST", body: "{}" });
		expect(r2.status).toBe(401);
	});

	it("uploads without a size limit and attaches a PDF with its text", async () => {
		const pdf = makePdf(["Escritura de compraventa del piso", "Notario en Oviedo, 2026"]);
		const up = await fetch(`${srv.url}/uploads/escritura.pdf`, { method: "PUT", headers: { authorization: `Bearer ${writeToken}` }, body: pdf });
		expect(up.status).toBe(201);
		const meta = (await up.json()) as { upload_id: string; size: number; sha256: string };
		expect(meta.size).toBe(pdf.length);
		expect(meta.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
		const ro = await fetch(`${srv.url}/uploads/x.pdf`, { method: "PUT", headers: { authorization: `Bearer ${readToken}` }, body: "x" });
		expect(ro.status).toBe(403);
		const client = await mcp(srv.url, writeToken);
		const att = parse(await client.callTool({ name: "attach", arguments: { path: "temas/escritura-piso.pdf", upload_id: meta.upload_id, title: "Escritura del piso", description: "Escritura de compraventa del piso de Oviedo", reason: "Adjuntar escritura" } }));
		expect(att).toMatchObject({ path: "temas/escritura-piso.md", attachment: "temas/escritura-piso.pdf", pages: 2 });
		const read = parse(await client.callTool({ name: "read", arguments: { name: "escritura-piso" } })) as { content: string; sections: { heading: string }[] };
		expect(read.content).toContain("![[escritura-piso.pdf]]");
		expect(read.sections.map((s) => s.heading)).toEqual(["Escritura del piso", "Página 1", "Página 2"]);
		const hits = parse(await client.callTool({ name: "search", arguments: { query: "notario" } })) as { hits: { path: string; section: { heading: string } }[] };
		expect(hits.hits[0]).toMatchObject({ path: "temas/escritura-piso.md", section: { heading: "Página 2" } });
		const attrs = await env.memory.git.out(["show", "HEAD:.gitattributes"]);
		expect(attrs).toContain("*.pdf filter=lfs");
		const pointer = await env.memory.git.out(["show", "HEAD:temas/escritura-piso.pdf"]);
		expect(pointer).toContain("version https://git-lfs.github.com/spec/v1");
		// A page without text is treated as a scan.
		const scan = parse(await client.callTool({ name: "attach", arguments: { path: "temas/escaneo.pdf", base64: makePdf([""]).toString("base64"), description: "Un escaneo", reason: "Escaneo", confirm_new: true } })) as { warnings: { code: string }[] };
		expect(scan.warnings.map((w) => w.code)).toContain("EXTRACTION_EMPTY");
		await client.close();
	});
});

describe("HTTP details", () => {
	it("answers tool calls with compact JSON, and instructions only when a client initializes", async () => {
		const client = await mcp(srv.url, writeToken);
		const raw = await fetch(`${srv.url}/mcp`, {
			method: "POST",
			headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list", arguments: {} } }),
		});
		const answer = (await raw.json()) as { result: { content: { text: string }[] } };
		const text = answer.result.content[0]?.text as string;
		// One line: no indentation in what a tool returns.
		expect(text).not.toContain("\n");
		expect(JSON.parse(text)).toHaveProperty("index");
		await client.close();
	});

	it("offers search with the common interface and the deadlines tool over MCP", async () => {
		const client = await mcp(srv.url, writeToken);
		const created = parse(
			await client.callTool({
				name: "create",
				arguments: {
					path: "temas/plazos.md",
					content: note("Plazos", "Con pendientes", "## Pendiente\n\n- [ ] Llamar al banco · Sam · 2026-04-02 [web]\n- [ ] Otra cosa · Sam · sin plazo\n", "type: project\nstatus: active\n"),
					reason: "Plazos",
				},
			}),
		);
		expect(created.commit).toBeTruthy();
		const hits = parse(await client.callTool({ name: "search", arguments: { query: "banco", limit: 1 } })) as { hits: { type: string | null; status: string | null }[]; total: number };
		expect(hits.hits[0]).toMatchObject({ type: "project", status: "active" });
		expect(hits.total).toBeGreaterThan(0);
		const filtered = parse(await client.callTool({ name: "search", arguments: { query: "banco", status: "paused" } })) as { hits: unknown[]; total: number };
		expect(filtered.hits).toEqual([]);
		const pend = parse(await client.callTool({ name: "deadlines", arguments: {} })) as { items: { text: string; owner: string; date: string }[] };
		expect(pend.items.map((i) => [i.text, i.owner, i.date])).toEqual([["Llamar al banco", "Sam", "2026-04-02"]]);
		const all = parse(await client.callTool({ name: "deadlines", arguments: { include_undated: true } })) as { items: { text: string; date: string | null }[] };
		expect(all.items.map((i) => i.date)).toEqual(["2026-04-02", null]);
		await client.close();
	});

	it("takes JSON bodies up to 32 MB", async () => {
		expect(MAX_MCP_BODY).toBe("32mb");
		const big = (n: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list", arguments: {}, pad: "x".repeat(n) } });
		// A couple of megabytes (over what a small note needs) goes through…
		const ok = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: big(2 * 1024 * 1024) });
		expect(ok.status).toBe(200);
		// …and one over the limit is refused, as 413 and not as a server error. Streamed, not built in memory.
		const chunk = "x".repeat(1024 * 1024);
		const chunks = 34;
		const status = await new Promise<number>((resolve) => {
			const request = httpRequest(
				`${srv.url}/mcp`,
				{ method: "POST", headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json", "content-length": String(chunks * chunk.length) } },
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			request.on("error", () => resolve(-1));
			for (let i = 0; i < chunks; i++) request.write(chunk);
			request.end();
		});
		expect(status).toBe(413);
	});

	it("has no git webhook any more", async () => {
		const r = await fetch(`${srv.url}/hooks/git`, { method: "POST", body: "{}" });
		expect(r.status).toBe(404);
	});
});
