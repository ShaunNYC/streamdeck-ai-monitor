#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
const url = `ws://127.0.0.1:${Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10)}`;
const ws = new WebSocket(url);
const messages = [];
let wake;
ws.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); wake?.(); });
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));

const next = (predicate, timeoutMs = 5_000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("Timed out waiting for security response")), timeoutMs);
	const check = () => { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); wake = undefined; resolve(messages.splice(index, 1)[0]); };
	wake = check; check();
});

const snapshot = await next((message) => message.type === "system.snapshot");
const task = snapshot.payload.tasks[0];
assert.ok(task, "No live task for binding test");
const wrongAgent = task.agent === "codex" ? "claude" : "codex";
ws.send(JSON.stringify({ type: "action.open", token, requestId: "wrong-agent", agentId: wrongAgent, payload: { agent: wrongAgent, taskId: task.taskId } }));
const mismatch = await next((message) => message.payload?.forRequestId === "wrong-agent");
assert.equal(mismatch.type, "error");
assert.equal(mismatch.payload.code, "unauthorized");

ws.send(JSON.stringify({ type: "action.approve", token, requestId: "stale-request", agentId: task.agent, payload: { agent: task.agent, taskId: task.taskId, requestId: "forged", viaHold: true } }));
const stale = await next((message) => message.payload?.forRequestId === "stale-request");
assert.equal(stale.type, "error");
assert.ok(["stale-request", "unauthorized"].includes(stale.payload.code));
ws.close();

const bad = new WebSocket(url);
const closed = new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("Invalid-token client was not closed")), 5_000);
	bad.once("close", (code) => { clearTimeout(timer); resolve(code); });
	bad.once("error", () => undefined);
});
await new Promise((resolve) => bad.once("open", resolve));
bad.send(JSON.stringify({ type: "client.hello", token: "invalid", payload: { client: "direct-hid-device", protocolVersion: 4 } }));
assert.equal(await closed, 1008);
console.log("[security-smoke] token rejection, agent/task binding and device decision denial: ok");
