#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const port = Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10);
const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const messages = [];
let wake;
ws.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); wake?.(); });
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));

const next = (predicate, timeoutMs = 30_000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("Timed out waiting for verification state")), timeoutMs);
	const check = () => {
		const index = messages.findIndex(predicate);
		if (index < 0) return;
		clearTimeout(timer);
		resolve(messages.splice(index, 1)[0]);
	};
	wake = check;
	check();
});

const initial = await next((message) => message.type === "system.snapshot");
const projectDirectory = path.resolve(process.env.AI_CONTROL_SUPERVISOR_VERIFY_CWD ?? process.cwd());
const candidates = initial.payload.tasks.filter((candidate) => candidate.verifyProfile && path.resolve(candidate.verifyProfile.cwd) === projectDirectory);
const task = candidates.find((candidate) => candidate.status === "RUNNING") ?? candidates[0];
assert.ok(task, "No task is mapped to the configured project's VERIFY command");
const verificationTimeoutMs = Math.max(30_000, task.verifyProfile.timeoutMs + 10_000);
const waitForResult = next(
	(message) => message.type === "system.snapshot" && message.payload.tasks.some((candidate) => candidate.taskId === task.taskId && ["pass", "fail"].includes(candidate.workflow?.state)),
	verificationTimeoutMs,
);
ws.send(JSON.stringify({
	type: "action.verify",
	token,
	requestId: "verify-smoke",
	agentId: task.agent,
	payload: { agent: task.agent, taskId: task.taskId },
}));
const result = await waitForResult;
const verified = result.payload.tasks.find((candidate) => candidate.taskId === task.taskId);
assert.equal(verified.workflow.state, "pass", `Verification failed; log: ${verified.workflow.logPath ?? "unknown"}`);
const openId = "verify-smoke-acknowledge";
ws.send(JSON.stringify({
	type: "action.open",
	token,
	requestId: openId,
	agentId: task.agent,
	payload: { agent: task.agent, taskId: task.taskId },
}));
const opened = await next((message) => (message.type === "ack" || message.type === "error") && message.payload?.forRequestId === openId);
assert.equal(opened.type, "ack", "Verification passed but its result could not be opened and acknowledged");
console.log(`[verify-smoke] ${task.verifyProfile.command} passed, opened the exact task and left no synthetic badge`);
ws.close();
