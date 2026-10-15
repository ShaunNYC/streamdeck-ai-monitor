#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { isMainContextTask } from "@streamdeck-supervisor/shared";

const run = promisify(execFile);

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10)}`);
const messages = [];
let wake;
ws.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); wake?.(); });
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));

const next = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("Timed out waiting for action response")), timeoutMs);
	const check = () => {
		const index = messages.findIndex(predicate);
		if (index < 0) return;
		clearTimeout(timer); wake = undefined; resolve(messages.splice(index, 1)[0]);
	};
	wake = check; check();
});

const snapshot = await next((message) => message.type === "system.snapshot");
const agents = ["claude", "codex"];
const available = agents.map((agent) => {
	const candidates = snapshot.payload.tasks.filter((task) => task.agent === agent);
	return { agent, task: candidates.find(isMainContextTask) ?? candidates[0], actionable: candidates.some(isMainContextTask) };
}).filter(({ task }) => task);
assert.ok(available.length > 0, "No task is available for deep-link smoke testing");
for (const [index, item] of available.entries()) {
	const { task } = item;
	if (!item.actionable) {
		assert.ok(task.openRef?.value, `${item.agent} historical task has no deep link`);
		await run("/usr/bin/open", [task.openRef.value]);
		console.log(`[action-smoke] ${item.agent} exact historical conversation deep link handed to macOS; device action correctly remains unavailable`);
		continue;
	}
	const selectId = `smoke-select-${index}`;
	ws.send(JSON.stringify({ type: "action.selectTask", token, requestId: selectId, agentId: task.agent, payload: { agent: task.agent, taskId: task.taskId } }));
	const selected = await next((message) => (message.type === "ack" || message.type === "error") && message.payload?.forRequestId === selectId);
	assert.equal(selected.type, "ack", `Could not select ${task.agent} task`);
	const openId = `smoke-open-${index}`;
	ws.send(JSON.stringify({ type: "action.open", token, requestId: openId, agentId: task.agent, payload: { agent: task.agent, taskId: task.taskId } }));
	const opened = await next((message) => (message.type === "ack" || message.type === "error") && message.payload?.forRequestId === openId);
	assert.equal(opened.type, "ack", `Could not open ${task.agent} deep link`);
	console.log(`[action-smoke] ${task.agent} exact conversation deep link opened`);
}
ws.close();
