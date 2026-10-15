import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createEnvelope } from "../packages/shared/src/index.ts";
import { IpcServer, type SupervisorConfig } from "../packages/daemon/src/api.ts";
import { DaemonClient } from "../packages/device/src/daemon-client.ts";
import { deviceState } from "../packages/device/src/state.ts";

async function main(): Promise<void> {
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pulse-mas-ipc-"));
process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = path.join(temporary, "data");
const transcriptDirectory = path.join(temporary, "transcripts");
fs.mkdirSync(transcriptDirectory);
const config: SupervisorConfig = {
	version: 2,
	projects: [],
	agents: { codex: { enabled: false }, claude: { enabled: true, transcriptDirectory } },
	device: { mode: "official", startAtLogin: false, showInMenuBar: false },
};
const originalListen = net.Server.prototype.listen;
let listenCount = 0;
net.Server.prototype.listen = function (...args: Parameters<typeof originalListen>) {
	listenCount++;
	throw new Error(`Observer mode attempted to bind a socket: ${String(args[0])}`);
} as typeof originalListen;
const server = new IpcServer({ adapterMode: "real", config, observerOnly: true });
const client = new DaemonClient();
try {
	await server.start();
	const unauthorized = server.connectInProcess();
	const rejected = new Promise<void>((resolve) => unauthorized.once("close", resolve));
	unauthorized.send(JSON.stringify(createEnvelope("client.hello", { client: "direct-hid-device", protocolVersion: 4 }, { token: "invalid" })));
	await rejected;
	// Stopping before the queued handshake must not send on a closed local socket.
	client.start(() => server.connectInProcess());
	client.stop();
	await new Promise<void>((resolve) => setImmediate(resolve));
	client.start(() => server.connectInProcess());
	await new Promise<void>((resolve, reject) => {
		if (!deviceState.isOffline()) return resolve();
		const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Device did not receive an IPC snapshot")); }, 2_000);
		const unsubscribe = deviceState.subscribe(() => {
			if (deviceState.isOffline()) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
	assert.equal(listenCount, 0);
	for (const agent of ["codex", "claude"] as const) {
		assert.equal(await client.sendDismissCompleted({ agent, executions: [] }), true, `${agent} dismiss action receives an acknowledgement`);
		assert.equal(await client.sendSelectTask(agent, "missing-task"), false, `${agent} invalid selection receives an error`);
	}
	assert.equal(server.status.adapters.claude.status, "OK", "Transcript observer starts without hook listener");
	console.log("MAS in-process IPC regression passed");
} finally {
	client.stop();
	await server.stop();
	net.Server.prototype.listen = originalListen;
	fs.rmSync(temporary, { recursive: true, force: true });
}
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
