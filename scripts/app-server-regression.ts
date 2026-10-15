import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { emptyTaskProgress, taskCapabilities, type AppServerStatus, type PendingPlanInput, type Task } from "@streamdeck-supervisor/shared";
import WebSocket, { WebSocketServer } from "ws";
import { buildMainTileModels } from "../packages/device/src/device-controller.js";
import { DeviceState } from "../packages/device/src/state.js";
import { CodexAppServerBridge, createPlanAnswerResponse, normalizeQuestions } from "../packages/daemon/src/codex-app-server-bridge.js";
import { ensureCodexAppServer } from "./codex-app-server.mjs";

const questions = normalizeQuestions([
	{
		header: "Direction",
		id: "direction",
		question: "How should the patch proceed?",
		options: [
			{ label: "small_patch", description: "Apply a small patch" },
			{ label: "refactor", description: "Refactor the module" },
		],
	},
]);
assert.equal(questions?.[0]?.options[0]?.label, "small_patch");
assert.equal(questions?.[0]?.options[0]?.description, "Apply a small patch");
assert.equal(normalizeQuestions([]), null);
assert.equal(normalizeQuestions([{ header: "Open", id: "open", question: "Explain", options: null }]), null);
assert.equal(normalizeQuestions([{ header: "Other", id: "other", question: "Choose", isOther: true, options: [{ label: "x", description: "X" }] }]), null);
assert.equal(normalizeQuestions(Array.from({ length: 9 }, (_, index) => ({ header: `Q${index}`, id: `q${index}`, question: "Choose", options: [{ label: "x", description: "X" }] }))), null);
assert.deepEqual(createPlanAnswerResponse(42, { direction: { answers: ["small_patch"] } }), {
	id: 42,
	result: { answers: { direction: { answers: ["small_patch"] } } },
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "neo-app-server-"));
const fakeBinary = path.join(directory, "fake-codex.mjs");
const fakeSocket = path.join(directory, "app-server-control.sock");
fs.writeFileSync(fakeBinary, `#!/usr/bin/env node
if (process.argv[2] === "app-server" && process.argv[3] === "daemon") {
  process.stdout.write(JSON.stringify({ command: process.argv[4], ok: true }));
  process.exit(0);
}
process.stderr.write("unexpected fake Codex command");
process.exit(2);
`, { encoding: "utf8", mode: 0o700 });

process.env.AI_CONTROL_SUPERVISOR_CODEX_BIN = fakeBinary;
process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET = fakeSocket;

type FakeMode = "health" | "control" | "happy" | "resolved" | "nonblocking" | "early-exit" | "upgrade-timeout" | "timeout" | "reconnect" | "resume-retry";
let fakeMode: FakeMode = "health";
let connectionSequence = 0;
let resumeAttempts = 0;
let capturedAnswer: unknown;
let resumes: string[] = [];
let controlMethods: string[] = [];
let controlInterruptParams: { threadId?: string; turnId?: string } | undefined;
let controlThreadType = "active";
let controlTurnId = "turn-control";
let controlTurnStatus = "inProgress";

const httpServer = http.createServer();
const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const serverSockets = new Set<import("node:net").Socket>();
httpServer.on("connection", (socket) => {
	serverSockets.add(socket);
	socket.once("close", () => serverSockets.delete(socket));
});
httpServer.on("upgrade", (request, socket, head) => {
	if (fakeMode === "upgrade-timeout") return;
	wsServer.handleUpgrade(request, socket, head, (connection) => wsServer.emit("connection", connection, request));
});

function send(connection: WebSocket, message: unknown): void {
	if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
}

function sendPlanInput(connection: WebSocket, requestId: string, processNumber: number, isBlocking = true): void {
	send(connection, {
		id: requestId,
		method: "item/tool/requestUserInput",
		params: {
			isBlocking,
			itemId: `item-${processNumber}`,
			threadId: "thread-1",
			turnId: `turn-${processNumber}`,
			questions: [
				{ header: "Direction", id: "direction", question: "Choose", options: [{ label: "small_patch", description: "Apply a small patch" }] },
				{ header: "Scope", id: "scope", question: "Choose scope", options: [{ label: "focused", description: "Keep the change focused" }] },
			],
		},
	});
}

wsServer.on("connection", (connection) => {
	const processNumber = ++connectionSequence;
	const mode = fakeMode;
	if (mode === "early-exit") {
		setTimeout(() => connection.close(1011, "fake app-server exited before initialize"), 5);
		return;
	}
	connection.on("message", (raw) => {
		const message = JSON.parse(raw.toString()) as { id?: string | number; method?: string; params?: { threadId?: string; turnId?: string } };
		if (message.method === "initialize") {
			if (mode !== "timeout") send(connection, { id: message.id, result: {} });
			return;
		}
		if (message.method === "thread/resume") {
			resumes.push(`${processNumber}:${message.params?.threadId ?? ""}`);
			if (mode === "resume-retry" && resumeAttempts++ === 0) {
				send(connection, { id: message.id, error: { code: -32600, message: "temporary writer conflict" } });
				return;
			}
			send(connection, { id: message.id, result: {} });
			if (mode === "happy") sendPlanInput(connection, "server-input", processNumber);
			else if (mode === "resolved") {
				sendPlanInput(connection, "server-resolved", processNumber);
				setTimeout(() => send(connection, { method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "server-resolved" } }), 20);
			} else if (mode === "nonblocking") sendPlanInput(connection, "server-nonblocking", processNumber, false);
			else if (mode === "reconnect") {
				sendPlanInput(connection, `server-reconnect-${processNumber}`, processNumber);
				if (processNumber === 1) setTimeout(() => connection.close(1011, "forced disconnect"), 30);
			}
			else if (mode === "resume-retry") sendPlanInput(connection, "server-retry", processNumber);
			return;
		}
		if (message.method === "thread/read") {
			controlMethods.push("thread/read");
			send(connection, {
				id: message.id,
				result: {
					thread: {
						id: message.params?.threadId,
						status: { type: controlThreadType },
						turns: [{ id: controlTurnId, status: controlTurnStatus, items: [] }],
					},
				},
			});
			return;
		}
		if (message.method === "turn/interrupt") {
			controlMethods.push("turn/interrupt");
			controlInterruptParams = { threadId: message.params?.threadId, turnId: message.params?.turnId };
			send(connection, { id: message.id, result: {} });
			return;
		}
		if (message.method === "thread/increment_elicitation" || message.method === "thread/decrement_elicitation") {
			const increment = message.method.includes("increment");
			send(connection, { id: message.id, result: { count: increment ? 1 : 0, paused: increment } });
			return;
		}
		if (String(message.id).startsWith("server-input")) capturedAnswer = message;
	});
});

interface Harness {
	bridge: CodexAppServerBridge;
	inputs: PendingPlanInput[];
	cleared: string[];
	statuses: AppServerStatus[];
}

function harness(mode: FakeMode, options: { requestTimeoutMs?: number; retryDelaysMs?: number[]; threadRetryDelaysMs?: number[]; planRelayEnabled?: boolean } = {}): Harness {
	fakeMode = mode;
	connectionSequence = 0;
	resumeAttempts = 0;
	capturedAnswer = undefined;
	resumes = [];
	controlMethods = [];
	controlInterruptParams = undefined;
	controlThreadType = "active";
	controlTurnId = "turn-control";
	controlTurnStatus = "inProgress";
	const inputs: PendingPlanInput[] = [];
	const cleared: string[] = [];
	const statuses: AppServerStatus[] = [];
	const bridge = new CodexAppServerBridge({
		getThreadIds: () => ["thread-1"],
		onInput: (input) => { inputs.push(structuredClone(input)); },
		onCleared: (requestId) => { cleared.push(requestId); },
		onStatus: (status) => { statuses.push(status); },
		...options,
	});
	return { bridge, inputs, cleared, statuses };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(predicate(), true, message);
}

function assertDeviceSnapshot(input: PendingPlanInput, appServerStatus: AppServerStatus): void {
	const now = Date.now();
	const task: Task = {
		taskId: input.taskId,
		agent: "codex",
		ownership: "observer",
		externalId: input.threadId,
		projectId: "stream-deck",
		projectLabel: "STREAMDEC",
		titleShort: "Choose implementation",
		status: "NEEDS_INPUT",
		attentionCount: 1,
		attentionVersion: 1,
		acknowledgedAttentionVersion: 0,
		capabilities: taskCapabilities({ review: true, verify: true }),
		progress: emptyTaskProgress(),
		openRef: { kind: "url", value: `codex://threads/${input.threadId}` },
		source: "mock",
		lastEventAt: now,
		startedAt: now,
	};
	const state = new DeviceState();
	state.setSnapshot([task], { selectedTaskId: { codex: task.taskId, claude: null }, activeAgent: "codex", newChatAgent: "codex" }, {
		daemonUptimeMs: 1,
		daemonPid: 1,
		configuredProjectCount: 1,
		runningTaskCount: 0,
		codexAppServer: appServerStatus,
		adapters: {
			codex: { status: "OK", lastPollAt: now },
			claude: { status: "OK", lastPollAt: now },
			workflow: { status: "OK", lastPollAt: now },
		},
	}, [input]);
	assert.equal(state.isCodexAppServerReady(), true);
	assert.equal(state.getActivePlanInput()?.requestId, input.requestId);
	const models = buildMainTileModels(state);
	assert.equal(models[1]?.badge, "?");
	assert.equal(models[1]?.detail, "PLAN");
}

async function listen(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(fakeSocket, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
}

async function closeServer(): Promise<void> {
	for (const connection of wsServer.clients) connection.terminate();
	for (const socket of serverSockets) socket.destroy();
	await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
	wsServer.close();
}

async function main(): Promise<void> {
	await listen();
	try {
		{
			fakeMode = "health";
			const managed = await ensureCodexAppServer({ binary: fakeBinary, socket: fakeSocket, waitMs: 500 });
			assert.equal(managed.ok, true, `managed-daemon helper should complete a real initialize handshake: ${managed.detail}`);
		}

		{
			const test = harness("happy");
			await test.bridge.start();
			assert.equal(test.bridge.getStatus().status, "OK");
			assert.equal(test.statuses[0]?.status, "CONNECTING");
			await waitFor(() => test.inputs.length === 1, "supported Plan input should reach the bridge");
			assertDeviceSnapshot(test.inputs[0]!, test.bridge.getStatus());
			const requestId = test.inputs[0]!.requestId;
			assert.equal(await test.bridge.answer(requestId, test.inputs[0]!.taskId, "direction", 0), "next");
			await waitFor(() => test.inputs.length === 2, "second question should be published");
			assert.equal(test.inputs[1]?.questionIndex, 1);
			assert.equal(await test.bridge.answer(requestId, test.inputs[0]!.taskId, "scope", 0), "complete");
			await waitFor(() => capturedAnswer !== undefined, "answer response should reach app-server");
			assert.deepEqual(capturedAnswer, createPlanAnswerResponse("server-input", { direction: { answers: ["small_patch"] }, scope: { answers: ["focused"] } }));
			await test.bridge.stop();
		}

		{
			const test = harness("control", { planRelayEnabled: false });
			await test.bridge.start();
			await test.bridge.interrupt("thread-1", "turn-control");
			assert.deepEqual(controlMethods, ["thread/read", "turn/interrupt"], "STOP must verify through thread/read before turn/interrupt");
			assert.deepEqual(controlInterruptParams, { threadId: "thread-1", turnId: "turn-control" });
			assert.deepEqual(resumes, [], "The standard STOP control path must never send thread/resume");
			controlThreadType = "idle";
			await assert.rejects(() => test.bridge.interrupt("thread-1", "turn-control"), /no active turn/);
			assert.deepEqual(controlMethods.slice(-1), ["thread/read"], "An inactive thread is rejected without an interrupt");
			controlThreadType = "active";
			controlTurnId = "newer-turn";
			await assert.rejects(() => test.bridge.interrupt("thread-1", "turn-control"), /no longer in progress/);
			assert.deepEqual(controlMethods.slice(-1), ["thread/read"], "A stale turn is rejected without an interrupt");
			controlTurnId = "turn-control";
			controlTurnStatus = "completed";
			await assert.rejects(() => test.bridge.interrupt("thread-1", "turn-control"), /no longer in progress/);
			await test.bridge.stop();
		}

		{
			const test = harness("resolved");
			await test.bridge.start();
			await waitFor(() => test.inputs.length === 1, "resolved test should receive an input");
			const requestId = test.inputs[0]!.requestId;
			await waitFor(() => test.cleared.includes(requestId), "serverRequest/resolved should clear stale Neo input");
			assert.equal(test.bridge.getPending(requestId), undefined);
			await test.bridge.stop();
		}

		{
			const test = harness("nonblocking");
			await test.bridge.start();
			await new Promise((resolve) => setTimeout(resolve, 60));
			assert.equal(test.inputs.length, 0, "non-blocking input must not take over Neo keys");
			await test.bridge.stop();
		}

		{
			const test = harness("early-exit", { requestTimeoutMs: 200, retryDelaysMs: [1_000] });
			await test.bridge.start();
			assert.equal(test.bridge.getStatus().status, "OFFLINE");
			assert.match(test.bridge.getStatus().lastError ?? "", /fake app-server exited before initialize/);
			await test.bridge.stop();
		}

		{
			const test = harness("upgrade-timeout", { requestTimeoutMs: 50, retryDelaysMs: [1_000] });
			await test.bridge.start();
			assert.equal(test.bridge.getStatus().status, "OFFLINE");
			assert.match(test.bridge.getStatus().lastError ?? "", /WebSocket handshake timed out after 50ms/);
			await test.bridge.stop();
		}

		{
			const test = harness("timeout", { requestTimeoutMs: 50, retryDelaysMs: [1_000] });
			await test.bridge.start();
			assert.equal(test.bridge.getStatus().status, "OFFLINE");
			assert.match(test.bridge.getStatus().lastError ?? "", /initialize timed out after 50ms/);
			await test.bridge.stop();
		}

		{
			const configuredSocket = process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET!;
			const test = harness("happy", { requestTimeoutMs: 50, retryDelaysMs: [1_000] });
			process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET = path.join(directory, "missing.sock");
			await test.bridge.start();
			assert.equal(test.bridge.getStatus().status, "OFFLINE");
			assert.match(test.bridge.getStatus().lastError ?? "", /control socket missing/);
			await test.bridge.stop();
			process.env.AI_CONTROL_SUPERVISOR_CODEX_APP_SERVER_SOCKET = configuredSocket;
		}

		{
			const test = harness("resume-retry", { threadRetryDelaysMs: [20] });
			await test.bridge.start();
			await waitFor(() => test.inputs.length === 1, "thread subscription should recover on its own after a bounded retry");
			assert.equal(resumes.length, 2, "thread retry should not depend on a registry change");
			await test.bridge.stop();
		}

		{
			const test = harness("reconnect", { requestTimeoutMs: 500, retryDelaysMs: [20] });
			await test.bridge.start();
			await waitFor(() => test.inputs.length >= 1, "first connection should receive Plan input");
			const firstRequestId = test.inputs[0]!.requestId;
			await waitFor(() => test.cleared.includes(firstRequestId), "disconnect should clear the first Plan input");
			await waitFor(() => test.inputs.length >= 2, "reconnect should resume the thread and receive a new input");
			assert.match(resumes.join("\n"), /1:thread-1[\s\S]*2:thread-1/);
			assert.ok(test.statuses.filter((status) => status.status === "OK").length >= 2, "bridge should become ready again after reconnect");
			await test.bridge.stop();
		}
	} finally {
		await closeServer();
		fs.rmSync(directory, { recursive: true, force: true });
	}
	console.log("[app-server-regression] read-only STOP verification, no-resume control, UDS recovery and Plan choices: ok");
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
