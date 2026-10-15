import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import sharp from "sharp";
import { emptyTaskProgress, taskCapabilities, type AgentKind, type Task, type TaskStatus } from "@streamdeck-supervisor/shared";
import {
	COLORS, INFOBAR_MARQUEE_END_MS, INFOBAR_MARQUEE_INITIAL_MS, INFOBAR_MARQUEE_SPEED_PX_PER_SECOND,
	infobarMarqueeOffset, layoutInfobar, layoutText, measureText, rasterizeSvg, renderEmptySlot, renderInfobar,
	renderMainTile, renderPlanChoiceTile, renderFailureTile, renderPressedTile, renderSystemTile, renderTaskCard,
	type TextLayout, type TileEmphasis,
} from "../packages/device/src/render.js";

const now = Date.now();
const suppliedCodexSvg = fs.readFileSync(new URL("../packages/device/assets/codex-color.svg", import.meta.url)).toString("base64");
const suppliedClaudeSvg = fs.readFileSync(new URL("../packages/device/assets/claude-color.svg", import.meta.url)).toString("base64");
const output = path.resolve("artifacts", "ui-qa-neo-refresh");
fs.mkdirSync(output, { recursive: true });

function sample(status: TaskStatus, agent: AgentKind = "codex"): Task {
	const attention = ["APPROVAL", "NEEDS_INPUT", "DONE_UNREAD", "ERROR"].includes(status);
	return {
		taskId: `${agent}-${status}`,
		agent,
		externalId: status,
		projectId: "stream-deck",
		projectLabel: "STREAMDEC",
		cwd: process.cwd(),
		titleShort: status === "NEEDS_INPUT" ? "Choose interaction mode" : status === "APPROVAL" ? "Install Stream Deck SDK" : status === "ERROR" ? "Resolve adapter failure" : "Build polished console",
		status,
		attentionCount: attention ? 1 : 0,
		attentionVersion: attention ? 1 : 0,
		acknowledgedAttentionVersion: 0,
		request: status === "APPROVAL" ? { requestId: "request", type: "network", target: "npm install", riskTier: 2, createdAt: now, expiresAt: now + 300_000, decisionPath: agent === "claude" ? "claude-hook" : "codex-shortcut" } : undefined,
		ownership: "observer",
		capabilities: taskCapabilities({ approve: status === "APPROVAL", reject: status === "APPROVAL", interrupt: status === "RUNNING", review: true, verify: true }),
		progress: {
			...emptyTaskProgress(),
			latestActivity: { category: "shell", state: status === "ERROR" ? "error" : status === "RUNNING" ? "running" : "done", label: status === "RUNNING" ? "Running regression tests" : "Processed latest event", at: now },
			todoCompleted: status === "RUNNING" ? 2 : 4,
			todoTotal: 4,
			currentTodo: status === "RUNNING" ? "Build installer" : undefined,
			activeSubagents: status === "RUNNING" ? 1 : 0,
			totalSubagents: 3,
			turnStartedAt: now - 600_000,
			durationMs: 600_000,
			recap: status === "DONE_UNREAD" ? "Built and verified the new installer." : undefined,
		},
		openRef: { kind: "url", value: agent === "codex" ? `codex://threads/${status}` : `claude://resume?session=${status}` },
		reviewRef: { kind: "result", value: status },
		verifyProfile: { command: "npm test", cwd: process.cwd(), timeoutMs: 120_000 },
		source: "mock",
		lastEventAt: now,
		startedAt: now - 600_000,
	};
}

function longSample(agent: AgentKind = "codex"): Task {
	const base = sample("RUNNING", agent);
	return {
		...base,
		projectLabel: "国际化PROJECT🚀WITHANUNBROKENTOKEN",
		titleShort: "修复超长标题与Supercalifragilisticexpialidocious🚀显示问题",
		progress: {
			...base.progress,
			latestActivity: { category: "shell", state: "running", label: "正在验证 extraordinarily-long-unbroken-activity-token 🚀", at: now },
			todoCompleted: 12,
			todoTotal: 24,
		},
	};
}

const empty = (agent: AgentKind) => renderEmptySlot(agent);
const embeddedImageSvg = (svg: string): string => {
	const encoded = /<image[^>]+href="data:image\/svg\+xml;base64,([^\"]+)"/.exec(svg)?.[1];
	assert.ok(encoded, "Tile must contain an embedded SVG image");
	return Buffer.from(encoded, "base64").toString("utf8");
};
const assertLayoutFits = (layout: TextLayout, maxWidth: number, label: string): void => {
	assert.ok(layout.size >= 8, `${label} dropped below the 8px hardware minimum`);
	assert.ok(layout.widths.every((width) => width <= maxWidth + 0.001), `${label} exceeded its ${maxWidth}px text region`);
};
const assertMinimumFontSize = (svg: string, label: string): void => {
	const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((match) => Number(match[1]));
	assert.ok(sizes.every((size) => size >= 8), `${label} contains text below 8px: ${sizes.join(", ")}`);
};
const assertMainTextSafe = (svg: string, label: string): void => {
	for (const match of svg.matchAll(/<text\b[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"/g)) {
		const x = Number(match[1]);
		const y = Number(match[2]);
		assert.ok(x >= 12 && x <= 84, `${label} text x=${x} escaped the 12px horizontal safety zone`);
		assert.ok(y >= 12 && y <= 80, `${label} text y=${y} escaped the vertical safety zone`);
	}
};
const agentTile = (agent: AgentKind, emphasis: TileEmphasis, badge?: string, detail?: string, actionable = emphasis !== "quiet") => renderMainTile({
	label: agent.toUpperCase(), accent: agent === "codex" ? COLORS.codex : COLORS.claude,
	actionable, emphasis, agent, badge, detail,
});
const actionTile = (label: string, accent: string, icon: string, emphasis: "quiet" | "active" = "active", detail?: string, hold = false) => renderMainTile({
	label, accent, icon, detail, hold, emphasis, actionable: emphasis === "active",
});

const statusTile = (label: string, icon: string, detail?: string, accent = COLORS.muted) => renderMainTile({
	label, icon, detail, accent, emphasis: detail ? "active" : "quiet", actionable: false,
});
const mutedStatusTile = (label: string, icon: string, detail: string, accent: string) => renderMainTile({
	label, icon, detail, accent, emphasis: "quiet", mutedDetail: true, actionable: false,
});
const activityTile = (value: string, liveCount: number, accent: string, emphasis: "quiet" | "active" = "active") => renderMainTile({
	label: "ACTIVITY",
	detail: value,
	accent,
	emphasis,
	actionable: false,
	icon: "activity",
	process: { kind: "activity", value, ...(liveCount > 0 ? { footer: `LIVE · ${liveCount}` } : {}) },
});
const mutedActivityTile = (value: string, footer: string) => renderMainTile({
	label: "ACTIVITY",
	detail: value,
	accent: COLORS.muted,
	emphasis: "quiet",
	mutedDetail: true,
	actionable: false,
	icon: "activity",
	process: { kind: "activity", value, footer },
});
const progressTile = (completed: number, total: number, liveTaskCount: number, accent: string, emphasis: "quiet" | "active" = "active") => renderMainTile({
	label: "PROGRESS",
	detail: total > 0 ? `${completed} / ${total}` : "—",
	accent,
	emphasis,
	actionable: false,
	process: { kind: "progress", completed, total, liveTaskCount },
});

function safetyMain(): string[] {
	return [
		actionTile("CODEX", COLORS.codex, "circle-gauge", "quiet"),
		agentTile("codex", "quiet"),
		agentTile("claude", "quiet"),
		actionTile("CLAUDE", COLORS.claude, "circle-gauge", "quiet"),
		actionTile("NEW CHAT", COLORS.codex, "message-square-plus", "quiet"),
		activityTile("QUIET", 0, COLORS.muted, "quiet"),
		progressTile(0, 0, 0, COLORS.muted, "quiet"),
		statusTile("AGENTS", "users"),
	];
}

function baseMain(newChatActive = true): string[] {
	return [
		actionTile("CODEX", COLORS.codex, "circle-gauge", "quiet"),
		agentTile("codex", "quiet", undefined, undefined, true),
		agentTile("claude", "quiet", undefined, undefined, true),
		actionTile("CLAUDE", COLORS.claude, "circle-gauge", "quiet"),
		renderMainTile({
			label: "NEW CHAT",
			detail: "CODEX",
			accent: COLORS.codex,
			icon: "message-square-plus",
			emphasis: newChatActive ? "active" : "quiet",
			actionable: true,
		}),
		activityTile("QUIET", 0, COLORS.muted, "quiet"),
		progressTile(0, 0, 0, COLORS.muted, "quiet"),
		statusTile("AGENTS", "users"),
	];
}

function withBaseMain(overrides: Partial<Record<number, string>>, newChatActive = true): string[] {
	const result = baseMain(newChatActive);
	for (const [index, svg] of Object.entries(overrides)) result[Number(index)] = svg;
	return result;
}

const liveCards: Array<[string, string]> = [
	["running-codex", renderTaskCard(sample("RUNNING"))],
	["approval-codex", renderTaskCard(sample("APPROVAL"))],
	["input-claude", renderTaskCard(sample("NEEDS_INPUT", "claude"))],
	["overflow", renderTaskCard(sample("RUNNING", "claude"), { overflowCount: 4 })],
	["long-content", renderTaskCard(longSample(), { overflowCount: 12 })],
	["offline", renderSystemTile("SUPERVISOR", "OFFLINE")],
];

const pages: Record<string, string[]> = {
	"codex-live-page": [liveCards[0]![1], liveCards[1]![1], ...Array.from({ length: 6 }, () => empty("codex"))],
	"codex-plan-choices": [
		renderPlanChoiceTile({ label: "small_patch", description: "Apply a small patch" }, "A"),
		renderPlanChoiceTile({ label: "refactor", description: "Refactor the module" }, "B"),
		renderPlanChoiceTile({ label: "ask_first", description: "Ask for more context" }, "C"),
		...Array.from({ length: 5 }, () => empty("codex")),
	],
	"claude-live-page": [liveCards[2]![1], renderTaskCard(sample("RUNNING", "claude")), ...Array.from({ length: 6 }, () => empty("claude"))],
	"codex-offline-page": [renderSystemTile("SUPERVISOR", "OFFLINE"), ...Array.from({ length: 7 }, () => empty("codex"))],
	"claude-setup-page": [renderSystemTile("SETUP", "REQUIRED", COLORS.approval, "settings"), ...Array.from({ length: 7 }, () => empty("claude"))],
	"long-content-page": [
		renderTaskCard(longSample(), { overflowCount: 12 }),
		renderPlanChoiceTile({ label: "international", description: "使用安全方式处理Supercalifragilisticexpialidocious🚀选项" }, "A"),
		renderSystemTile("CLAUDE SOURCE DISABLED", "ENABLE IN APP", COLORS.error, "circle-alert"),
		renderMainTile({ label: "ACTIVITY", detail: "正在执行 EXTRAORDINARILY LONG VALIDATION 🚀", accent: COLORS.codex, icon: "activity", emphasis: "active", actionable: false, process: { kind: "activity", value: "正在执行 EXTRAORDINARILY LONG VALIDATION 🚀", footer: "LIVE · 99+" } }),
		...Array.from({ length: 4 }, () => empty("codex")),
	],
	"main-idle": baseMain(false),
	"main-codex-running": withBaseMain({
		0: actionTile("HIGH", COLORS.codex, "circle-gauge", "active", "CODEX"),
		1: agentTile("codex", "active"),
		5: activityTile("TESTING", 1, COLORS.codex),
		6: progressTile(2, 4, 1, COLORS.codex),
		7: statusTile("AGENTS", "users", "1/3 · 10M", COLORS.codex),
	}),
	"main-dual-running": withBaseMain({
		0: actionTile("HIGH", COLORS.codex, "circle-gauge", "active", "CODEX"),
		1: agentTile("codex", "active"),
		2: agentTile("claude", "active"),
		3: actionTile("MEDIUM", COLORS.claude, "circle-gauge", "active", "CLAUDE"),
		5: activityTile("TESTING", 3, COLORS.codex),
		6: progressTile(5, 8, 3, COLORS.codex),
		7: statusTile("AGENTS", "users", "2/4 · 12M", COLORS.codex),
	}),
	"main-claude-running": withBaseMain({
		0: actionTile("HIGH", COLORS.codex, "circle-gauge", "active", "CODEX"),
		1: agentTile("codex", "active"),
		2: agentTile("claude", "active"),
		3: actionTile("MEDIUM", COLORS.claude, "circle-gauge", "active", "CLAUDE"),
		4: renderMainTile({ label: "NEW CHAT", detail: "CLAUDE", accent: COLORS.claude, icon: "message-square-plus", emphasis: "active", actionable: true }),
		5: activityTile("WRITING", 3, COLORS.claude),
		6: progressTile(5, 8, 3, COLORS.claude),
		7: statusTile("AGENTS", "users", "2/4 · 12M", COLORS.claude),
	}),
	"main-claude-new-chat": withBaseMain({
		4: actionTile("NEW CHAT", COLORS.claude, "message-square-plus", "active", "CLAUDE"),
	}),
	"main-approval": withBaseMain({
		2: agentTile("claude", "attention", "1"),
		5: activityTile("WAITING", 1, COLORS.claude),
		6: progressTile(1, 3, 1, COLORS.claude),
		7: statusTile("AGENTS", "users", "0/0 · 1M5S", COLORS.claude),
	}, false),
	"main-codex-approval": withBaseMain({
		1: agentTile("codex", "attention", "1"),
		5: activityTile("WAITING", 1, COLORS.codex),
		6: progressTile(2, 4, 1, COLORS.codex),
		7: statusTile("AGENTS", "users", "0/0 · 1M5S", COLORS.codex),
	}, false),
	"main-input": withBaseMain({
		1: agentTile("codex", "attention", "?", "QUESTION"),
	}, false),
	"main-completion": withBaseMain({
		1: agentTile("codex", "attention", "1"),
	}, false),
	"main-error": withBaseMain({
		2: agentTile("claude", "attention", "1"),
	}, false),
	"main-terminal-recap": withBaseMain({
		5: mutedActivityTile("COMPLETED", "DONE"),
		6: progressTile(0, 0, 0, COLORS.muted, "quiet"),
		7: mutedStatusTile("AGENTS", "users", "0/0 · 1M5S", COLORS.codex),
	}, false),
	"main-offline": [renderSystemTile("SUPERVISOR", "OFFLINE"), ...safetyMain().slice(1)],
	"main-setup": [renderSystemTile("SETUP", "REQUIRED", COLORS.approval, "settings"), ...safetyMain().slice(1)],
};

async function main(): Promise<void> {
	for (const [name, svg] of liveCards) {
		assert.match(svg, /^<svg[^>]+width="96"[^>]+height="96"/);
		assert.ok(svg.includes('x="4" y="4" width="88" height="88" rx="14"'), `${name} needs the simplified 8px-safe rounded shell`);
		assert.ok(svg.includes('stroke-width="2"'), `${name} needs the readable 2px perimeter ring`);
		assert.ok(!svg.includes('x="7" y="7" width="82"'), `${name} must remove the decorative inner border`);
		assert.ok(!svg.includes('d="M20 5.5H76"'), `${name} still contains the obsolete top strip`);
		if (name !== "offline") assert.ok(!/>\s*\d+(?:m|h)\s*</.test(svg), `${name} must not show elapsed time`);
		assertMinimumFontSize(svg, name);
		await sharp(Buffer.from(svg)).png().toFile(path.join(output, `${name}.png`));
	}
	assert.ok(liveCards.find(([name]) => name === "long-content")?.[1].includes("RUN · +12"), "Overflow count belongs in the status pill instead of the metadata row");
	assert.ok(liveCards.find(([name]) => name === "long-content")?.[1].includes('clip-path="url(#taskTitle)"'), "Long task titles need a hard clip fallback");

	for (const [label, value, maxWidth, maxLines] of [
		["English words", "Run extraordinarily detailed hardware regression checks", 76, 2],
		["Chinese", "调整整套NEO硬件界面并确保所有文字清晰可读", 76, 2],
		["Emoji", "Validate 👩‍💻🚀🧪 hardware output", 76, 2],
		["Unbroken token", "Supercalifragilisticexpialidocious", 49, 1],
	] as const) {
		const layout = layoutText(value, { maxWidth, maxLines, sizes: [10.5, 9.5, 8] });
		assertLayoutFits(layout, maxWidth, label);
		assert.ok(layout.lines.length <= maxLines, `${label} exceeded its line limit`);
	}

	const quietAction = actionTile("VERIFY", COLORS.verify, "test-tube-2", "quiet", "READY", true);
	assert.ok(quietAction.includes('data-emphasis="quiet"') && quietAction.includes('data-actionable="false"'));
	assert.ok(quietAction.includes("VERIFY") && quietAction.includes(COLORS.quietRing) && quietAction.includes(COLORS.quietIcon));
	assert.ok(!quietAction.includes("READY") && !quietAction.includes("HOLD"), "Quiet actions only retain icon and name");
	assert.ok(!quietAction.includes(COLORS.verify), "Quiet actions must not leak functional color");

	const quietCodex = agentTile("codex", "quiet", "9");
	const activeCodex = agentTile("codex", "active");
	const activeClaude = agentTile("claude", "active");
	const attentionClaude = agentTile("claude", "attention", "3");
	const planChoice = renderPlanChoiceTile({ label: "small_patch", description: "Apply a small patch" }, "A");
	const focusedAttentionCodex = renderMainTile({ label: "CODEX", accent: COLORS.codex, actionable: true, emphasis: "attention", agent: "codex", badge: "1" });
	const codexTask = renderTaskCard(sample("RUNNING", "codex"));
	const codexQuestion = renderTaskCard(sample("NEEDS_INPUT", "codex"));
	const claudeTask = renderTaskCard(sample("RUNNING", "claude"));
	const pressed = renderPressedTile(activeCodex, 1);
	assert.ok(pressed.includes('data-pressed="true"') && pressed.includes('scale(0.7000)'), "Successful actions must visually depress the existing key surface to 70%");
	assert.ok(!pressed.includes("circle-check") && !pressed.includes("circle-check-big"), "Press feedback must not replace the key with a green check");
	const failure = renderFailureTile("OPEN FAILED");
	assert.ok(failure.includes(COLORS.error) && !failure.includes(COLORS.done), "Failure feedback remains an alert, never a success check");
	const quietCodexAsset = embeddedImageSvg(quietCodex);
	const quietCodexPaths = quietCodexAsset.match(/<path\b/g) ?? [];
	assert.ok(quietCodex.includes('data-quiet-agent="codex"') && !quietCodex.match(/<image[^>]+filter="url\(#monochrome\)"/));
	assert.equal(quietCodexPaths.length, 1, "Quiet Codex must contain only the flower/terminal path");
	assert.ok(quietCodexAsset.includes("Codex quiet") && quietCodexAsset.includes('fill="#8E9AA9"') && !quietCodexAsset.includes('fill="#fff"') && !quietCodexAsset.includes("M19.503 0H4.496"), "Quiet Codex removes the supplied square app backdrop");
	assert.ok(!quietCodex.includes(">9<") && !quietCodex.includes(COLORS.codex), "Quiet Agent has no badge or brand surface");
	assert.ok(activeCodex.includes("#FFFFFF") && activeCodex.includes('stroke-width="2"'), "Running Codex keeps the white brand treatment with a simplified ring");
	assert.ok(activeClaude.includes("#FFFFFF") && activeClaude.includes(`stroke="${COLORS.claude}"`) && activeClaude.includes('stroke-width="2"'), "Running Claude mirrors the simplified Codex structure with an orange ring");
	assert.ok(!activeClaude.includes('x="19" y="8" width="58" height="58"') && !activeClaude.includes("#161B26"), "Claude keeps only the flower mark without a rounded icon backing");
	assert.ok(!activeClaude.includes("#FF8A63") && !activeClaude.includes("#F06A43"), "Claude strong state must not fill the whole key orange");
	assert.ok(codexTask.includes(COLORS.codex) && !claudeTask.includes(COLORS.codex), "Codex running tasks use Codex blue, not the ChatGPT/cyan accent");
	assert.ok(codexQuestion.includes(">QUESTION<") && codexQuestion.includes(COLORS.input), "Codex Plan fallback renders a visible question reminder");
	assert.ok(activeCodex.includes(suppliedCodexSvg), "Codex tile must embed the supplied Codex SVG asset");
	assert.ok(attentionClaude.includes(suppliedClaudeSvg), "Claude tile must embed the supplied Claude SVG asset");
	assert.ok(attentionClaude.includes(COLORS.claude) && attentionClaude.includes(">3<") && attentionClaude.includes('stroke-opacity=".7"') && attentionClaude.includes('stroke-width="3"'), "Attention adds a readable 3px badge halo");
	assert.ok(planChoice.includes('data-role="plan-option"') && planChoice.includes('data-marker="A"'), "Plan choice has an explicit option marker");
	assert.ok(planChoice.includes('cx="17" cy="17"'), "Plan option marker is centered on the simplified card corner geometry");
	assert.ok(planChoice.includes("Apply") && planChoice.includes("patch") && !planChoice.includes(">small_patch<") && planChoice.includes('clip-path="url(#choiceText)"'), "Plan choice prioritizes a safely clipped description over option label");
	assert.ok(focusedAttentionCodex.includes('data-emphasis="attention"') && focusedAttentionCodex.includes('data-actionable="true"') && focusedAttentionCodex.includes(">1<"), "A bright attention Logo remains actionable");
	assert.ok(!activeCodex.includes("circle-check") && !activeCodex.includes("selected"), "Agent Logo must not render selected checks");

	for (const agent of ["codex", "claude"] as const) {
		const svg = empty(agent);
		assert.ok(svg.includes('data-role="empty-slot"') && svg.includes('stroke-width="2"'));
		assert.ok(svg.includes("data:image/svg+xml;base64") && svg.includes(`data-quiet-agent="${agent}"`));
		if (agent === "codex") {
			const asset = embeddedImageSvg(svg);
			assert.equal((asset.match(/<path\b/g) ?? []).length, 1, "Empty Codex slot must contain only the flower/terminal path");
			assert.ok(asset.includes('fill="#8E9AA9"') && !asset.includes("M19.503 0H4.496"), "Empty Codex slot must not restore the square app backdrop");
		}
		else assert.ok(svg.match(/<image[^>]+filter="url\(#monochrome\)"/), "Quiet Claude keeps the monochrome treatment");
		assert.ok(!svg.includes("<text"), "Empty slot must not contain labels, numbering, READY, or NO TASK");
	}

	for (const [name, svgs] of Object.entries(pages)) {
		for (const [index, svg] of svgs.entries()) {
			assertMinimumFontSize(svg, `${name} key ${index}`);
			if (name.startsWith("main-")) assertMainTextSafe(svg, `${name} key ${index}`);
		}
		await renderPage(name, svgs);
	}
	await renderPage("main-page", pages["main-codex-running"]!);

	for (const [index, svg] of pages["main-idle"]!.entries()) assert.equal(svg.includes('data-actionable="true"'), [1, 2, 4].includes(index), `Idle key ${index} rendered actionability must match the model`);
	assert.ok(pages["main-idle"]![1]!.includes('data-emphasis="quiet"') && pages["main-idle"]![1]!.includes('data-actionable="true"'), "Grey Codex Logo remains clickable");
	assert.ok(pages["main-idle"]![2]!.includes('data-emphasis="quiet"') && pages["main-idle"]![2]!.includes('data-actionable="true"'), "Grey Claude Logo remains clickable");
	assert.ok(pages["main-idle"]![4]!.includes('data-emphasis="quiet"') && pages["main-idle"]![4]!.includes('data-actionable="true"'), "Idle New Chat is grey but remains clickable");
	assert.ok(!pages["main-idle"]![4]!.includes(COLORS.codex), "Idle New Chat must not leak the persisted Agent accent");
	assert.ok(pages["main-approval"]![4]!.includes('data-emphasis="quiet"'), "Approval without a RUNNING task must keep New Chat grey");
	assert.ok(!pages["main-claude-new-chat"]![4]!.includes(">CLAUDE<") && pages["main-claude-new-chat"]![4]!.includes(COLORS.claude), "Claude New Chat mirrors Codex with orange accent");
	for (const label of ["CODEX", "CLAUDE", "NEW CHAT", "ACTIVITY", "PROGRESS", "AGENTS"]) {
		assert.ok(pages["main-idle"]!.some((svg) => svg.includes(`>${label}<`)), `Idle page keeps ${label} identifiable`);
	}
	for (const index of [5, 6, 7]) assert.ok(pages["main-codex-running"]![index]!.includes('data-actionable="false"'), `Status card ${index} must remain non-actionable`);
	for (const pageName of ["main-codex-running", "main-dual-running", "main-codex-approval"] as const) {
		for (const index of [5, 6, 7]) assert.ok(pages[pageName]![index]!.includes(COLORS.codex), `${pageName} process card ${index} must use Codex blue`);
	}
	for (const index of [5, 6, 7]) assert.ok(pages["main-approval"]![index]!.includes(COLORS.claude), `Claude process card ${index} must use Claude orange`);
	for (const index of [5, 6, 7]) assert.ok(pages["main-claude-running"]![index]!.includes(COLORS.claude), `Live Claude process card ${index} must use Claude orange`);
	assert.ok(pages["main-claude-running"]![6]!.includes('data-ratio="0.6250"'), "Claude Progress keeps the same aggregate 5/8 ratio while switching to orange");
	for (const index of [5, 6, 7]) {
		const terminalCard = pages["main-terminal-recap"]![index]!;
		assert.ok(terminalCard.includes('data-emphasis="quiet"') && terminalCard.includes('data-actionable="false"'), `Terminal status card ${index} must be a neutral inert data card`);
		assert.ok(!terminalCard.includes(COLORS.codex) && !terminalCard.includes(COLORS.claude), `Terminal status card ${index} must not leak an Agent live color`);
	}
	assert.ok(pages["main-terminal-recap"]![5]!.includes("COMPLETED") && pages["main-terminal-recap"]![5]!.includes("DONE"), "Terminal Activity keeps a concise neutral recap state");
	assert.ok(pages["main-terminal-recap"]![6]!.includes('data-role="progress"') && pages["main-terminal-recap"]![6]!.includes("—"), "Global Progress clears when no live tasks remain");
	assert.ok(pages["main-terminal-recap"]![7]!.includes("0/0 · 1M5S"), "Terminal Agent duration remains readable while grey");
	assert.ok(pages["main-dual-running"]![5]!.includes('data-role="activity"') && pages["main-dual-running"]![5]!.includes("LIVE · 3"), "Activity uses a stable pulse layout with a compact live-task footer");
	assert.ok(pages["main-dual-running"]![6]!.includes('data-role="progress"') && pages["main-dual-running"]![6]!.includes('data-ratio="0.6250"'), "Progress fills from the aggregate 5/8 completion ratio");
	assert.ok(pages["main-dual-running"]![6]!.includes('data-live-tasks="3"') && !pages["main-dual-running"]![6]!.includes("VERIFY"), "Progress shows only aggregate counts, never Todo detail text");
	assert.ok(!pages["main-idle"]!.some((svg) => svg.includes(">HIGH<") || svg.includes(">MEDIUM<")), "Idle Main must hide reasoning levels");
	assert.ok(pages["main-idle"]![0]!.includes("circle-gauge") || pages["main-idle"]![0]!.includes("M15.6 2.7"), "Reasoning uses the local circle-gauge icon");

	const approvalBar = renderInfobar({ runningCount: 0, approval: { agent: "claude", target: "sk-proj12345678901234567890 /Users/alice/private/configuration/file" } });
	assert.ok(approvalBar.includes("CLAUDE APPROVAL") && approvalBar.includes("[REDACTED_CREDENTIAL]") && approvalBar.includes("~"), "Approval context is Agent-labelled and redacted before reaching the LCD");
	assert.ok(!approvalBar.includes("sk-proj") && !approvalBar.includes("/Users/alice"));
	const approvalLayout = layoutInfobar({ runningCount: 0, approval: { agent: "claude", target: "sk-proj12345678901234567890 /Users/alice/private/configuration/file" } });
	assert.ok(approvalLayout.detailWidth > approvalLayout.detailViewportWidth, "Long approval context remains complete and opts into marquee instead of character truncation");
	assert.ok(approvalBar.includes('clip-path="url(#detailClip)"') && approvalBar.includes('font-size="10"'), "Infobar details use the 10px clipped marquee viewport");
	assert.ok(approvalBar.includes('<g clip-path="url(#detailClip)"><g transform="translate('), "The stationary LCD clip must wrap the moving text group so scrolling never escapes the frame");
	const errorBar = renderInfobar({ runningCount: 0, error: { agent: "claude", detail: "Failed with sk-proj12345678901234567890 while packaging." } });
	assert.ok(errorBar.includes("CLAUDE ERROR") && errorBar.includes(COLORS.error), "A pending terminal error is Agent-labelled and uses the error accent");
	assert.ok(errorBar.includes("[REDACTED_CREDENTIAL]") && !errorBar.includes("sk-proj"), "Error details are redacted before reaching the LCD");
	const fallbackErrorBar = renderInfobar({ runningCount: 0, error: { agent: "codex" } });
	assert.ok(fallbackErrorBar.includes("CODEX ERROR") && fallbackErrorBar.includes("TASK FAILED"), "An error without a recap keeps an explicit fallback detail");
	const errorOverRecap = renderInfobar({ runningCount: 1, error: { agent: "codex", detail: "Failed" }, recap: "Completed" });
	assert.ok(errorOverRecap.includes("CODEX ERROR") && !errorOverRecap.includes(">RECAP<"), "Pending errors take priority over success recaps and running counts");

	const bars = [
		["idle", renderInfobar({ runningCount: 0 }), "NO TASKS RUNNING"],
		["one", renderInfobar({ runningCount: 1 }), "1 TASK RUNNING"],
		["many", renderInfobar({ runningCount: 3 }), "3 TASKS RUNNING"],
		["offline", renderInfobar({ offline: true, runningCount: 0 }), "SUPERVISOR OFFLINE"],
		["approval", approvalBar, "CLAUDE APPROVAL"],
		["resolved", renderInfobar({ runningCount: 0, notice: { label: "RESOLVED ELSEWHERE", detail: "CODEX · NO ACTION SENT", kind: "resolved" } }), "RESOLVED ELSEWHERE"],
		["expired", renderInfobar({ runningCount: 0, notice: { label: "APPROVAL EXPIRED", detail: "CLAUDE · NO ACTION SENT", kind: "expired" } }), "APPROVAL EXPIRED"],
		["question", renderInfobar({ waitingInput: "codex", runningCount: 0 }), "CODEX QUESTION WAITING"],
		["plan", renderInfobar({ runningCount: 1, plan: { questionNumber: 1, totalQuestions: 3, optionCount: 3, question: "Choose a safe implementation" } }), "PLAN Q1/3 · 3 OPTIONS"],
		["error", errorBar, "CLAUDE ERROR"],
		["recap", renderInfobar({ runningCount: 0, recap: "Built and verified the signed test installer." }), "RECAP"],
	] as const;
	for (const [name, svg, expected] of bars) {
		assert.ok(svg.includes(expected));
		assertMinimumFontSize(svg, `infobar ${name}`);
		assert.ok(!svg.includes("<circle"), `${name} Infobar must not duplicate the Touch Point status light with a colored dot`);
		assert.ok(!/\b(?:1\/3|2\/3|3\/3|\d{1,2}:\d{2})\b/.test(svg), `${name} must not show page or clock`);
		if (["approval", "resolved", "expired", "question", "plan", "error", "recap"].includes(name)) assert.ok(svg.includes('x="18"') && svg.includes('text-anchor="start"'), `${name} two-line Infobar must use the full left text area`);
		else assert.ok(svg.includes('x="124"') && svg.includes('text-anchor="middle"'), `${name} single-line Infobar must be centered after removing the dot`);
		await sharp(Buffer.from(svg)).png().toFile(path.join(output, `infobar-${name}.png`));
	}

	const marqueeOverflow = 96;
	assert.equal(infobarMarqueeOffset(marqueeOverflow, INFOBAR_MARQUEE_INITIAL_MS), 0, "Marquee holds the readable beginning for 1.2 seconds");
	assert.equal(infobarMarqueeOffset(marqueeOverflow, INFOBAR_MARQUEE_INITIAL_MS + 1_000), INFOBAR_MARQUEE_SPEED_PX_PER_SECOND, "Marquee moves at exactly 24px/s");
	const travelMs = marqueeOverflow / INFOBAR_MARQUEE_SPEED_PX_PER_SECOND * 1_000;
	assert.equal(infobarMarqueeOffset(marqueeOverflow, INFOBAR_MARQUEE_INITIAL_MS + travelMs + INFOBAR_MARQUEE_END_MS - 1), marqueeOverflow, "Marquee holds the final characters for 0.8 seconds");
	assert.equal(infobarMarqueeOffset(marqueeOverflow, INFOBAR_MARQUEE_INITIAL_MS + travelMs + INFOBAR_MARQUEE_END_MS), 0, "Marquee resets after the end hold");
	const approvalOverflow = Math.max(0, approvalLayout.detailWidth - approvalLayout.detailViewportWidth);
	const approvalFrames = [
		["start", 0],
		["middle", approvalOverflow / 2],
		["end", approvalOverflow],
	] as const;
	for (const [name, scrollOffset] of approvalFrames) {
		const svg = renderInfobar({ runningCount: 0, approval: { agent: "claude", target: "sk-proj12345678901234567890 /Users/alice/private/configuration/file" } }, { scrollOffset });
		await sharp(Buffer.from(svg)).png().toFile(path.join(output, `infobar-marquee-${name}.png`));
	}

	assert.equal((await rasterizeSvg(liveCards[0]![1], 96, 96)).byteLength, 96 * 96 * 4);
	console.log("[ui-regression] NEO readable text layout, simplified surfaces and LCD marquee: ok");
}

async function renderPage(name: string, svgs: string[]): Promise<void> {
	assert.equal(svgs.length, 8);
	const page = await sharp({ create: { width: 384, height: 192, channels: 4, background: "#000000" } })
		.composite(svgs.map((svg, index) => ({ input: Buffer.from(svg), left: (index % 4) * 96, top: Math.floor(index / 4) * 96 })))
		.png()
		.toFile(path.join(output, `${name}.png`));
	assert.equal(page.width, 384);
	assert.equal(page.height, 192);
}

void main();
