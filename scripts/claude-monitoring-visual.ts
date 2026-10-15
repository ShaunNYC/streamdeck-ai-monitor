import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { emptyTaskProgress, taskCapabilities, type AgentKind, type ReasoningEffort, type SystemStatus, type Task } from "@streamdeck-supervisor/shared";
import { DeviceState } from "../packages/device/src/state.js";
import { buildMainTileModels, buildTouchPointColors, nextContentPage } from "../packages/device/src/device-controller.js";
import { renderMainTile } from "../packages/device/src/render.js";

async function main(): Promise<void> {
	const now = Date.now();
	const output = path.resolve("artifacts/claude-monitoring");
	fs.mkdirSync(output, { recursive: true });
	const make = (agent: AgentKind, model: string, reasoningEffort: ReasoningEffort): Task => ({
		taskId: `${agent}-validation`, agent, externalId: `${agent}-validation`, executionId: `${agent}-turn`,
		projectId: "validation", projectLabel: "VALIDATE", cwd: process.cwd(), titleShort: "Build and check",
		status: "RUNNING", ownership: "observer", attentionCount: 0, capabilities: taskCapabilities({ review: true }),
		source: "mock", openRef: { kind: "url", value: "" }, model, reasoningEffort,
		progress: {
			...emptyTaskProgress(), turnStartedAt: now - 65_000, durationMs: 65_000,
			todoCompleted: agent === "claude" ? 1 : 0, todoTotal: agent === "claude" ? 7 : 0,
			latestActivity: { category: "plan", label: "Checking result", state: "running", at: now + (agent === "claude" ? 1 : 0) },
		},
		startedAt: now - 65_000, lastEventAt: now,
	});
	const codex = make("codex", "gpt-6.1-sol", "high");
	const claude = make("claude", "claude-sonnet-5", "medium");
	const focus = { activeAgent: "claude" as const, newChatAgent: "claude" as const, selectedTaskId: { codex: codex.taskId, claude: claude.taskId } };
	const status: SystemStatus = {
		daemonUptimeMs: 0, daemonPid: 1, configuredProjectCount: 0, runningTaskCount: 2, monitoringScope: "all-projects",
		adapters: { codex: { status: "OK", lastPollAt: now }, claude: { status: "OK", lastPollAt: now }, workflow: { status: "OK", lastPollAt: now } },
		monitor: {
			selectedAgent: "claude", days: {},
			slots: {
				codex: [{ taskId: codex.taskId, executionId: codex.executionId!, slot: 0, durationMs: 65_000 }],
				claude: [{ taskId: claude.taskId, executionId: claude.executionId!, slot: 0, durationMs: 65_000 }],
			},
		},
	};
	const state = new DeviceState();
	state.setSnapshot([codex, claude], focus, status);
	const page = async (name: string) => {
		const buffers = await Promise.all(buildMainTileModels(state).map(model => sharp(Buffer.from(renderMainTile(model))).png().toBuffer()));
		await sharp({ create: { width: 384, height: 192, channels: 4, background: "#000000" } })
			.composite(buffers.map((input, i) => ({ input, left: (i % 4) * 96, top: Math.floor(i / 4) * 96 })))
			.png().toFile(path.join(output, name));
	};
	await page("dual-agent-main.png");
	claude.reasoningEffort = undefined;
	claude.model = undefined;
	claude.progress = { ...emptyTaskProgress(), turnStartedAt: now };
	state.setSnapshot([codex, claude], focus, { ...status, reasoningDefaults: { claude: "high" } });
	await page("claude-new-turn-unknown.png");
	const navigation = {
		left: nextContentPage(state, 0, -1), right: nextContentPage(state, 0, 1),
		claudeEnd: nextContentPage(state, 1, 1) ?? null, lights: buildTouchPointColors(state, 0),
	};
	fs.writeFileSync(path.join(output, "navigation.json"), JSON.stringify(navigation, null, 2) + "\n");
	console.log("[claude-monitoring-visual] synthetic production models, actual/unknown metadata and navigation rendered");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
