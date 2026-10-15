import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "blocking-hook-smoke-"));
const dataDirectory = path.join(temporary, "data");
const workspace = path.join(temporary, "workspace");
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const [port, hookPort] = await distinctPorts();
const configPath = path.join(dataDirectory, "config.json");
fs.writeFileSync(configPath, `${JSON.stringify({
	version: 2,
	projects: [{ id: "hook-smoke", label: "HOOK", cwd: workspace }],
	agents: { codex: { enabled: false }, claude: { enabled: true } },
	device: { mode: "official", startAtLogin: false, showInMenuBar: false },
}, null, 2)}\n`, { mode: 0o600 });

process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = dataDirectory;
process.env.AI_CONTROL_SUPERVISOR_CONFIG = configPath;
process.env.AI_CONTROL_SUPERVISOR_PORT = String(port);
process.env.AI_CONTROL_SUPERVISOR_HOOK_PORT = String(hookPort);
process.env.AI_CONTROL_SUPERVISOR_ADAPTER_MODE = "real";
process.env.AI_CONTROL_SUPERVISOR_CLAUDE_HOOK_MODE = "blocking";

const { IpcServer } = await import("../packages/daemon/dist/api.js");
const server = new IpcServer();
let ws;

try {
	await server.start();
	const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
	ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const messages = [];
	const snapshots = [];
	let wake;
	ws.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		messages.push(message);
		if (message.type === "system.snapshot") snapshots.push(message.payload);
		wake?.();
	});
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	ws.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));

	const next = (predicate, timeoutMs = 8_000) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for temporary Daemon IPC message")), timeoutMs);
		const check = () => {
			const index = messages.findIndex(predicate);
			if (index < 0) return;
			clearTimeout(timer);
			wake = undefined;
			resolve(messages.splice(index, 1)[0]);
		};
		wake = check;
		check();
	});
	await next((message) => message.type === "system.snapshot");

	const hookBody = {
		session_id: "blocking-hook-fifo-session",
		cwd: workspace,
		hook_event_name: "PermissionRequest",
		tool_name: "Bash",
		tool_input: { command: "npm test" },
	};
	const postHook = () => fetch(`http://127.0.0.1:${hookPort}/hook/claude`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-ai-control-token": token },
		body: JSON.stringify(hookBody),
	});
	const taskId = `claude:${hookBody.session_id}`;
	const response = await postHook();
	assert.equal(response.status,200);
	assert.deepEqual(await response.json(),{}, "Supervisor must not take over Claude's permission decisions");
	const observed = await next(message => message.type === "system.snapshot" && message.payload.tasks.some(task => task.taskId === taskId));
	assert.equal(observed.payload.tasks.find(task => task.taskId === taskId).status,"RUNNING");
	const waiting = next(message => message.type === "system.snapshot" && message.payload.tasks.some(task => task.taskId === taskId && task.status === "NEEDS_INPUT"));
	hookBody.hook_event_name="Notification"; hookBody.notification_type="permission_prompt";
	await postHook(); await waiting;
	const resumed=next(message => message.type === "system.snapshot" && message.payload.tasks.some(task => task.taskId === taskId && task.status === "RUNNING"));
	hookBody.hook_event_name="PostToolUse";delete hookBody.notification_type;
	await postHook();await resumed;
	console.log("[hook-observation-smoke] auto approvals pass through; explicit human prompt and resumed work reflected: ok");

} finally {
	if (ws && ws.readyState !== WebSocket.CLOSED) {
		await new Promise((resolve) => {
			ws.once("close", resolve);
			ws.close();
		});
	}
	await server.stop().catch(() => undefined);
	fs.rmSync(temporary, { recursive: true, force: true });
}

async function distinctPorts() {
	const first = await availablePort();
	let second = await availablePort();
	while (second === first) second = await availablePort();
	return [first, second];
}

function availablePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") return reject(new Error("Could not allocate a local test port"));
			probe.close((error) => error ? reject(error) : resolve(address.port));
		});
	});
}
