import type { Server } from "node:http";
import { join } from "node:path";
import { TokenStore } from "./auth/tokens.js";
import { buildClientsReport, ClientActivity, type ClientsService } from "./clients.js";
import type { ServerConfig } from "./config.js";
import { createApp } from "./http.js";
import { jsonLogger, type Logger } from "./log.js";
import { MemoryService } from "./memory.js";

export interface RunningServer {
	memory: MemoryService;
	tokens: TokenStore;
	server: Server;
	stop: () => Promise<void>;
}

function listen(app: ReturnType<typeof createApp>, address: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = app.listen(port, address, () => resolve(server));
		server.once("error", reject);
		server.requestTimeout = 0; // a big publish has no time limit
		server.headersTimeout = 60_000;
	});
}

export async function startServer(config: ServerConfig, log: Logger = jsonLogger(undefined, config.logLevel)): Promise<RunningServer> {
	if (config.ignoredKeys.length) log("warn", "config.ignored_keys", { keys: config.ignoredKeys, why: "this server no longer syncs with a git remote, accepts a push webhook nor extracts text from attached files; the notes repo lives in data_dir" });
	const memory = new MemoryService({
		repoDir: join(config.dataDir, "repo"),
		indexPath: join(config.dataDir, "index.sqlite"),
		branch: config.branch,
		authorDomain: config.authorDomain,
		log,
	});
	await memory.start();
	const tokens = new TokenStore(config.tokensFile);
	const activity = new ClientActivity(join(config.dataDir, "activity.sqlite"));
	const clients: ClientsService = {
		record: (client, tool) => activity.record(client, tool),
		report: () =>
			buildClientsReport({
				git: memory.git,
				repoDir: memory.opts.repoDir,
				staticClients: () => tokens.list(),
				activity: () => activity.all(),
			}),
	};
	const flushActivity = setInterval(() => {
		try {
			activity.flush();
		} catch (error) {
			log("warn", "clients.flush_failed", { error: String(error) });
		}
	}, 60_000);
	flushActivity.unref();
	const server = await listen(createApp({ memory, tokens, log, clients }), config.listen.address, config.listen.port);
	log("info", "server.started", {
		listen: `${config.listen.address}:${config.listen.port}`,
		tokens: tokens.count,
	});
	return {
		memory,
		tokens,
		server,
		stop: async () => {
			clearInterval(flushActivity);
			await new Promise<void>((r) => server.close(() => r()));
			await memory.stop();
			activity.close();
		},
	};
}
