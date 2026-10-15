import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { IpcServer } from "../packages/daemon/src/ipc-server.js";

async function main(): Promise<void> {
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "approval-ipc-regression-"));
process.env.AI_CONTROL_SUPERVISOR_DATA_DIR = temporary;
const port = await availablePort();
const server = new IpcServer({
	port,
	adapterMode: "mock",
	config: {
		version: 2,
		projects: [],
		agents: { codex: { enabled: true }, claude: { enabled: true } },
		device: { mode: "official", startAtLogin: false, showInMenuBar: false },
	},
});
let socket: WebSocket | undefined;

try {
	await server.start();
	const token = fs.readFileSync(server.tokenPath, "utf8").trim();
	socket = new WebSocket(`ws://127.0.0.1:${port}`);
	const messages: Array<Record<string, any>> = [];
	let wake: (() => void) | undefined;
	socket.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); wake?.(); });
	await new Promise<void>((resolve, reject) => {
		socket!.once("open", () => resolve());
		socket!.once("error", reject);
	});
	socket.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));

	const next = (predicate: (message: Record<string, any>) => boolean, timeoutMs = 5_000): Promise<Record<string, any>> => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for IPC approval response")), timeoutMs);
		const check = () => {
			const index = messages.findIndex(predicate);
			if (index < 0) return;
			clearTimeout(timer);
			wake = undefined;
			resolve(messages.splice(index, 1)[0]!);
		};
		wake = check;
		check();
	});
	const snapshot = await next((message) => message.type === "system.snapshot");
	const tierOneCodex = snapshot.payload.tasks.find((task: Record<string, any>) => task.taskId === "codex-1");
	const rejectedCodex = snapshot.payload.tasks.find((task: Record<string, any>) => task.taskId === "codex-2");
	assert.ok(tierOneCodex?.request && rejectedCodex?.request);

	const sendDecision = async (clientRequestId: string, type: string, task: Record<string, any>, viaHold: boolean) => {
		socket!.send(JSON.stringify({
			type,
			token,
			requestId: clientRequestId,
			agentId: task.agent,
			payload: { agent: task.agent, taskId: task.taskId, requestId: task.request?.requestId, executionId: task.executionId, viaHold },
		}));
		return next((message) => message.payload?.forRequestId === clientRequestId);
	};

	for (const [id, type, task, viaHold] of [
		["codex-approve-click", "action.approve", tierOneCodex, false],
		["codex-approve-hold", "action.approve", tierOneCodex, true],
		["codex-reject-click", "action.reject", rejectedCodex, false],
		["codex-stop-hold", "action.stop", snapshot.payload.tasks.find((task: Record<string, any>) => task.taskId === "codex-0"), true],
	] as const) {
		const response = await sendDecision(id, type, task, viaHold);
		assert.equal(response.type, "error");
		assert.equal(response.payload.code, "unauthorized");
		assert.match(response.payload.message, /not available to the device/i);
	}
	assert.equal(server.registry.getTask(tierOneCodex.taskId)?.status, "APPROVAL");
	assert.equal(server.registry.getTask(rejectedCodex.taskId)?.status, "APPROVAL");

	const running = server.registry.getTask("codex-0")!;
	const slot = server.status.monitor!.slots.codex.find(slot => slot.taskId === running.taskId)!;
	assert.ok(slot);
	let reply = await sendDecision("clear-running", "action.dismissDeviceTask", {...running,executionId:slot.executionId},false);
	assert.equal(reply.type,"error");
	server.registry.upsertTask({...running,status:"PAUSED",executionId:slot.executionId,lastEventAt:Date.now()});
	reply = await sendDecision("clear-old", "action.dismissDeviceTask", {...running,executionId:"wrong"},false);
	assert.equal(reply.payload.code,"stale-request");
	reply = await sendDecision("clear-stopped", "action.dismissDeviceTask", {...running,executionId:slot.executionId},false);
	assert.equal(reply.type,"ack");
	assert.equal(server.registry.getTask(running.taskId),undefined,"Clearing a stopped execution also removes it from the desktop source");
	assert.ok(!server.status.monitor!.slots.codex.some(slot => slot.taskId === running.taskId));

 const batch = async (id:string, payload:unknown, agentId="codex") => {
  socket!.send(JSON.stringify({type:"action.dismissCompletedDeviceTasks",token,requestId:id,agentId,payload}));
  return next(message=>message.payload?.forRequestId===id);
 };
 const finished={...running,taskId:"batch-finished",externalId:"batch-finished",executionId:"batch-turn",status:"RUNNING" as const,lastEventAt:Date.now()};
 server.registry.upsertTask(finished);
 assert.ok(server.status.monitor!.slots.codex.some(s=>s.taskId===finished.taskId));
 server.registry.upsertTask({...finished,status:"DONE_UNREAD",lastEventAt:Date.now()+1});
 reply=await batch("batch-malformed",{agent:"codex",executions:[{}]});assert.equal(reply.type,"error");
 reply=await batch("batch-wrong-agent",{agent:"claude",executions:[{taskId:finished.taskId,executionId:"batch-turn"}]},"claude");assert.equal(reply.payload.code,"unauthorized");
 reply=await batch("batch-old-turn",{agent:"codex",executions:[{taskId:finished.taskId,executionId:"old-turn"}]});assert.equal(reply.type,"ack");
 assert.ok(server.status.monitor!.slots.codex.some(s=>s.taskId===finished.taskId));
 reply=await batch("batch-completed",{agent:"codex",executions:[{taskId:finished.taskId,executionId:"batch-turn"}]});assert.equal(reply.type,"ack");
 assert.ok(!server.status.monitor!.slots.codex.some(s=>s.taskId===finished.taskId));
 assert.equal(server.registry.getTask(finished.taskId),undefined,"Batch clearing removes desktop history");
 reply=await batch("batch-repeat",{agent:"codex",executions:[{taskId:finished.taskId,executionId:"batch-turn"}]});assert.equal(reply.type,"ack");

	console.log("[ipc-approval-regression] protocol V4 rejects approve, reject and stop from every device request: ok");
} finally {
	if (socket && socket.readyState !== WebSocket.CLOSED) {
		await new Promise<void>((resolve) => {
			socket!.once("close", () => resolve());
			socket!.close();
		});
	}
	await server.stop().catch(() => undefined);
	fs.rmSync(temporary, { recursive: true, force: true });
}
}

function availablePort(): Promise<number> {
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

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
