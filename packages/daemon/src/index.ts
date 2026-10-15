import { IpcServer } from "./ipc-server.js";

const server = new IpcServer();

try {
	await server.start();
} catch (error) {
	console.error("[daemon] failed to start", error);
	process.exitCode = 1;
}

const shutdown = async (signal: string) => {
	console.log(`[daemon] ${signal}, stopping`);
	await server.stop();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
