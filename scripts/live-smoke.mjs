#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildMainTileModels, buildTouchPointColors } from "../packages/device/dist/device-controller.js";
import { DeviceState } from "../packages/device/dist/state.js";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const port = Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10);
const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
const socket = new WebSocket(`ws://127.0.0.1:${port}`);

const snapshot = await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("Timed out waiting for daemon snapshot")), 5_000);
	socket.once("open", () => socket.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } })));
	socket.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		if (message.type !== "system.snapshot") return;
		clearTimeout(timer);
		resolve(message.payload);
	});
	socket.once("error", reject);
});
socket.close();

assert.equal(snapshot.status.monitoringScope, "all-projects", "Daemon is not monitoring every project");
assert.notEqual(snapshot.status.adapters.codex.status, "OFFLINE", "Codex adapter is offline");
for (const task of snapshot.tasks) {
	assert.ok(task.titleShort && task.titleShort.length <= 42, "Task title is missing or too long");
	assert.match(task.openRef.value, task.agent === "codex" ? /^codex:\/\/threads\/[0-9a-f-]+$/ : /^claude:\/\/resume\?session=[^&]+$/);
	assert.equal(task.capabilities.device.interrupt, undefined, "Device capabilities must never expose interrupt");
	assert.equal(task.capabilities.device.approve, undefined, "Device capabilities must never expose approval");
}
assert.equal(snapshot.tasks.some((task) => /guardian|subagent|sidechain/i.test(`${task.taskId} ${task.titleShort} ${task.source}`)), false, "Internal helper task leaked into the physical UI");
const liveState = new DeviceState();
liveState.setSnapshot(snapshot.tasks, snapshot.focus, snapshot.status, snapshot.planInputs ?? []);
console.log(JSON.stringify({
	configuredProjects: snapshot.status.configuredProjectCount,
	monitoringScope: snapshot.status.monitoringScope,
	deviceConnection: snapshot.status.deviceConnection,
	adapters: snapshot.status.adapters,
	codexAppServer: snapshot.status.codexAppServer,
	codexApprovalControl: snapshot.status.codexApprovalControl,
	newChatAgent: snapshot.focus.newChatAgent ?? "codex",
	main: buildMainTileModels(liveState).map((model, key) => ({ key, label: model.label, detail: model.detail, actionable: model.actionable, emphasis: model.emphasis })),
	touchPoints: buildTouchPointColors(liveState),
	tasks: snapshot.tasks.map((task) => ({
		agent: task.agent,
		slot: task.slot,
		status: task.status,
		source: task.source,
		decisionPath: task.request?.decisionPath,
		ownership: task.ownership,
		activity: task.progress.latestActivity?.label,
		todo: `${task.progress.todoCompleted}/${task.progress.todoTotal}`,
		agents: `${task.progress.activeSubagents}/${task.progress.totalSubagents}`,
		hasExecutionId: !!task.executionId,
	})),
}, null, 2));
