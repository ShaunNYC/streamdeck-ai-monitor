import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import WebSocket from "ws";
import type { AgentKind, SystemSnapshotPayload } from "@streamdeck-supervisor/shared";
import { buildMainTileModels } from "../packages/device/src/device-controller.js";
import { renderEmptySlot, renderInfobar, renderMainTile, renderTaskCard, renderTaskColumnKey } from "../packages/device/src/render.js";
import { DeviceState } from "../packages/device/src/state.js";

const dataDirectory = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
const token = fs.readFileSync(path.join(dataDirectory, "token"), "utf8").trim();
const output = path.resolve("artifacts", "live-v3.1");
fs.mkdirSync(output, { recursive: true });

async function main(): Promise<void> {
	const snapshot = await getSnapshot();
	const state = new DeviceState();
	state.setSnapshot(snapshot.tasks, snapshot.focus, snapshot.status);

	const main = buildMainTileModels(state).map(renderMainTile);
	const codex = taskPage(state, "codex");
	const claude = taskPage(state, "claude");
	await renderPage("main", main);
	await renderPage("codex", codex);
	await renderPage("claude", claude);

	const bar = renderInfobar({ runningCount: snapshot.status.runningTaskCount });
	await sharp({ create: { width: 384, height: 250, channels: 4, background: "#000000" } })
		.composite([
			...main.map((svg, index) => ({ input: Buffer.from(svg), left: (index % 4) * 96, top: Math.floor(index / 4) * 96 })),
			{ input: Buffer.from(bar), left: 68, top: 192 },
		])
		.png()
		.toFile(path.join(output, "live-console.png"));

	const summary = {
		capturedAt: new Date().toISOString(),
		runningTaskCount: snapshot.status.runningTaskCount,
		adapters: snapshot.status.adapters,
		agents: {
			codex: state.getAgentSummary("codex"),
			claude: state.getAgentSummary("claude"),
		},
		main: buildMainTileModels(state).map(({ label, emphasis, actionable, badge }) => ({ label, emphasis, actionable, badge })),
		tasks: snapshot.tasks.map((task) => ({ agent: task.agent, status: task.status, pendingAttention: (task.attentionVersion ?? 0) > (task.acknowledgedAttentionVersion ?? 0) })),
	};
	fs.writeFileSync(path.join(output, "live-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	console.log(`[live-ui] captured exact daemon-backed V3.1 frame in ${output}`);
}

void main();

function taskPage(deviceState: DeviceState, agent: AgentKind): string[] {
	return Array.from({ length: 8 }, (_, slot) => {
		const item = deviceState.getDisplayTask(agent, slot % 4);
		return item.task ? renderTaskColumnKey(item.task, slot >= 4, deviceState.getSlot(item.task)?.durationMs) : renderEmptySlot(agent);
	});
}

async function renderPage(name: string, svgs: string[]): Promise<void> {
	await sharp({ create: { width: 384, height: 192, channels: 4, background: "#000000" } })
		.composite(svgs.map((svg, index) => ({ input: Buffer.from(svg), left: (index % 4) * 96, top: Math.floor(index / 4) * 96 })))
		.png()
		.toFile(path.join(output, `${name}.png`));
}

async function getSnapshot(): Promise<SystemSnapshotPayload> {
	const ws = new WebSocket(`ws://127.0.0.1:${Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10)}`);
	await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	return await new Promise<SystemSnapshotPayload>((resolve, reject) => {
		const timer = setTimeout(() => { ws.close(); reject(new Error("Timed out waiting for live snapshot")); }, 10_000);
		ws.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.type !== "system.snapshot") return;
			clearTimeout(timer);
			ws.close();
			resolve(message.payload as SystemSnapshotPayload);
		});
		ws.send(JSON.stringify({ type: "client.hello", token, payload: { client: "direct-hid-device", protocolVersion: 4 } }));
	});
}
