import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { emptyTaskProgress, taskCapabilities, type PendingPlanInput, type Task } from "@streamdeck-supervisor/shared";
import { daemonClient } from "../packages/device/src/daemon-client.js";
import {
	buildMainTileModels, buildTouchPointColors, nextContentPage, estimateRemainingWork, DeviceController, resolveTerminalInfobar, SUCCESS_RECAP_VISIBLE_MS,
} from "../packages/device/src/device-controller.js";
import { DeviceState, deviceState } from "../packages/device/src/state.js";

const now = Date.now();

function task(agent: "codex" | "claude", id: string, status: Task["status"], overrides: Partial<Task> = {}): Task {
	const attention = ["APPROVAL", "NEEDS_INPUT", "DONE_UNREAD", "ERROR"].includes(status);
	return {
		taskId: `${agent}-${id}`,
		...(status === "RUNNING" ? { executionId: `${agent}:${id}:turn-1` } : {}),
		agent,
		ownership: "observer",
		externalId: id,
		projectId: "p",
		projectLabel: "PROJECT",
		titleShort: `Task ${id}`,
		status,
		attentionCount: attention ? 1 : 0,
		attentionVersion: attention ? 1 : 0,
		acknowledgedAttentionVersion: 0,
		...(status === "APPROVAL" ? {
			request: {
				requestId: `${agent}-${id}-request`,
				type: "permission",
				target: `${agent} safe operation`,
				riskTier: 1 as const,
				createdAt: now,
				expiresAt: now + 60_000,
				decisionPath: agent === "codex" ? "codex-shortcut" as const : "claude-hook" as const,
			},
		} : {}),
		capabilities: taskCapabilities({ approve: status === "APPROVAL", reject: status === "APPROVAL", interrupt: status === "RUNNING", review: true, verify: true }),
		progress: emptyTaskProgress(),
		openRef: { kind: "url", value: agent === "codex" ? `codex://threads/${id}` : `claude://resume?session=${id}` },
		reviewRef: { kind: "result", value: id },
		verifyProfile: { command: "true", cwd: process.cwd(), timeoutMs: 1_000 },
		source: "mock",
		lastEventAt: now,
		startedAt: now,
		...overrides,
	};
}

const status = {
	daemonUptimeMs: 1,
	daemonPid: 1,
	configuredProjectCount: 1,
	monitoringScope: "all-projects" as const,
	deviceConnection: { state: "CONNECTED" as const, devices: [] },
	runningTaskCount: 1,
	adapters: {
		codex: { status: "OK" as const, lastPollAt: 1 },
		claude: { status: "OK" as const, lastPollAt: 1 },
		workflow: { status: "OK" as const, lastPollAt: 1 },
	},
	reasoningDefaults: { codex: "high" as const, claude: "medium" as const },
};

{
	const recap = "Built and verified the installer.";
	const completed = task("codex", "recent-recap", "DONE_UNREAD", {
		progress: { ...emptyTaskProgress(), recap },
	});
	assert.deepEqual(resolveTerminalInfobar([completed], now + SUCCESS_RECAP_VISIBLE_MS - 1), {
		kind: "recap",
		recap,
		expiresAt: now + SUCCESS_RECAP_VISIBLE_MS,
	}, "A completion recap remains visible through the last millisecond of its 30-second window");
	assert.equal(resolveTerminalInfobar([completed], now + SUCCESS_RECAP_VISIBLE_MS), undefined, "A completion recap expires exactly 30 seconds after the terminal event");

	const acknowledged = {
		...completed,
		status: "DONE" as const,
		attentionCount: 0,
		acknowledgedAttentionVersion: completed.attentionVersion,
	};
	assert.equal(resolveTerminalInfobar([acknowledged], now + 1)?.kind, "recap", "Reading a completed task does not shorten the recap window");
	const restoredOld = { ...acknowledged, lastEventAt: now - SUCCESS_RECAP_VISIBLE_MS };
	assert.equal(resolveTerminalInfobar([restoredOld], now), undefined, "An old restored snapshot cannot replay its recap");

	const newer = task("claude", "newer-recap", "DONE_UNREAD", {
		lastEventAt: now + 10,
		progress: { ...emptyTaskProgress(), recap: "Newer recap" },
	});
	assert.equal(resolveTerminalInfobar([completed, newer], now + 11)?.recap, "Newer recap", "The newest completion owns the recap window and deadline");

	const pendingError = task("claude", "pending-error", "ERROR", {
		lastEventAt: now + 20,
		attentionExpiresAt: now + 10 * 60_000,
		progress: { ...emptyTaskProgress(), recap: "Build failed safely." },
	});
	assert.deepEqual(resolveTerminalInfobar([newer, pendingError], now + 21), {
		kind: "error",
		agent: "claude",
		detail: "Build failed safely.",
		expiresAt: now + 10 * 60_000,
	}, "A pending error takes priority over a recent successful recap");
	const acknowledgedError = { ...pendingError, attentionCount: 0, acknowledgedAttentionVersion: pendingError.attentionVersion };
	assert.equal(resolveTerminalInfobar([acknowledgedError], now + 21), undefined, "An acknowledged error immediately leaves the Infobar");
	assert.equal(resolveTerminalInfobar([pendingError], pendingError.attentionExpiresAt!), undefined, "An error leaves the Infobar at its reminder deadline without waiting for daemon cleanup");
}

{
	const state = new DeviceState();
	const retained = task("codex", "retained", "DONE");
	const far = task("codex", "far", "PAUSED");
	state.setSnapshot([retained, far], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, {
		...status, monitor: { days: {}, slots: { codex: [
			{ taskId: retained.taskId, executionId: "1", slot: 0, durationMs: 0 },
			{ taskId: far.taskId, executionId: "2", slot: 8, durationMs: 0 },
		], claude: [] } },
	});
	assert.equal(nextContentPage(state, -1, -1), -3, "Empty intermediate pages are skipped");
	assert.equal(nextContentPage(state, -1, 1), 0);
	assert.equal(nextContentPage(state, -3, -1), undefined);
	assert.equal(nextContentPage(state, 0, 1), undefined);
	assert.deepEqual(buildTouchPointColors(state, -3), { codex: [0, 0, 0], claude: [122, 157, 255] });
	state.setSnapshot([retained], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, {
		...status, monitor: { days: {}, slots: { codex: [{ taskId: retained.taskId, executionId: "1", slot: 0, durationMs: 0 }], claude: [] } },
	});
	assert.deepEqual(buildTouchPointColors(state, -1), { codex: [0, 0, 0], claude: [180, 190, 208] }, "At -1 with no -2 content, only the right light is on for overview");
	assert.equal(nextContentPage(state, 3, -1), 0, "An empty current page always has a route home");
}

{
	const state = new DeviceState();
	state.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null, newChatAgent: "codex" }, { ...status, configuredProjectCount: 0 });
	assert.equal(state.isSetup(), false, "All-project monitoring remains ready with zero metadata projects");
	const { monitoringScope: _scope, ...legacyStatus } = { ...status, configuredProjectCount: 0 };
	state.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null, newChatAgent: "codex" }, legacyStatus);
	assert.equal(state.isSetup(), true, "A legacy status payload still uses configuredProjectCount for SETUP");
}

{
	const state = new DeviceState();
	const tasks = [
		task("codex", "running", "RUNNING", { startedAt: now - 5_000 }),
		task("codex", "approval", "APPROVAL", { startedAt: now - 4_000 }),
		task("codex", "input", "NEEDS_INPUT", { startedAt: now - 3_000 }),
		task("codex", "done", "DONE_UNREAD"),
		task("codex", "error", "ERROR"),
		task("codex", "paused", "PAUSED"),
	];
	state.setSnapshot(tasks, { selectedTaskId: { codex: "codex-approval", claude: null }, activeAgent: "codex" }, status);
	assert.deepEqual(state.getLiveTasks("codex").map((item) => item.status), ["RUNNING", "APPROVAL", "NEEDS_INPUT"]);
	assert.equal(state.getDisplayTask("codex", 0).task?.taskId, "codex-running");
	assert.equal(state.getDisplayTask("codex", 1).task?.taskId, "codex-approval");
	assert.equal(state.getDisplayTask("codex", 2).task?.taskId, "codex-input");
	assert.equal(state.getAgentSummary("codex").badge, 4, "Only four pending decision/review tasks contribute attention state");
	assert.equal(state.getAgentSummary("codex").visualState, "attention");
	assert.equal(state.getAgentSummary("codex").actionable, true);
}

{
	const state = new DeviceState();
	const acknowledgedError = task("claude", "old-error", "ERROR", { acknowledgedAttentionVersion: 1, attentionCount: 0 });
	state.setSnapshot([acknowledgedError, task("claude", "paused", "PAUSED")], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
	assert.deepEqual(state.getAgentSummary("claude"), { visualState: "quiet", actionable: false, badge: 0, runningCount: 0, decisionCount: 0, liveCount: 0 });
}

{
	const state = new DeviceState();
	const oldError = task("claude", "six-day-error", "ERROR", {
		lastEventAt: now - 6 * 24 * 60 * 60_000,
		lastObservedAt: now,
		attentionExpiresAt: now - 1,
	});
	state.setSnapshot([oldError], { selectedTaskId: { codex: null, claude: oldError.taskId }, activeAgent: "claude", newChatAgent: "codex" }, { ...status, runningTaskCount: 0 });
	assert.equal(state.getAgentSummary("claude").visualState, "quiet", "Historical Claude ERROR must not look active");
	const newError = { ...oldError, lastEventAt: now, attentionExpiresAt: now + 10 * 60_000 };
	state.setSnapshot([newError], { selectedTaskId: { codex: null, claude: newError.taskId }, activeAgent: "claude", newChatAgent: "codex" }, { ...status, runningTaskCount: 0 });
	assert.equal(state.getAgentSummary("claude").visualState, "error");
	assert.equal(buildMainTileModels(state)[2]?.emphasis, "error", "New ERROR uses a dark terminal tile, never the white working tile");
}

{
	const state = new DeviceState();
	state.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
	assert.deepEqual(buildTouchPointColors(state), { codex: [0, 0, 0], claude: [0, 0, 0] });

	const codexRunning = task("codex", "touch-running", "RUNNING");
	const codexApproval = task("codex", "touch-approval", "APPROVAL");
	const claudeDone = task("claude", "touch-done", "DONE_UNREAD");
	state.setSnapshot([codexRunning, codexApproval, claudeDone], { selectedTaskId: { codex: codexApproval.taskId, claude: claudeDone.taskId }, activeAgent: "codex" }, status);
	assert.deepEqual(buildTouchPointColors(state), { codex: [122, 157, 255], claude: [0, 0, 0] }, "Lights indicate navigable pages, never task status");

	const acknowledgedDone = { ...claudeDone, status: "DONE" as const, attentionCount: 0, acknowledgedAttentionVersion: claudeDone.attentionVersion };
	state.setSnapshot([codexApproval, acknowledgedDone], { selectedTaskId: { codex: codexApproval.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
	assert.deepEqual(buildTouchPointColors(state), { codex: [122, 157, 255], claude: [0, 0, 0] });
	state.setOffline();
	assert.deepEqual(buildTouchPointColors(state), { codex: [0, 0, 0], claude: [0, 0, 0] });
}

{
	const state = new DeviceState();
	state.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
	const models = buildMainTileModels(state);
	assert.deepEqual(models.map((model) => model.label), ["REASONING", "CODEX", "CLAUDE", "REASONING", "NEW CHAT", "ACTIVITY", "PROGRESS", "TODAY"]);
	assert.deepEqual(models.map((model) => model.actionable), [false, true, true, false, true, false, false, false]);
	assert.equal(models[0]?.detail, undefined, "Idle Codex must not expose a reasoning level");
	assert.equal(models[3]?.detail, undefined, "Idle Claude must not expose a reasoning level");
	assert.equal(models[0]?.icon, "circle-gauge");
	assert.equal(models[3]?.icon, "circle-gauge");
	assert.equal(models[1]?.emphasis, "quiet", "Idle Codex Logo is grey but remains clickable");
	assert.equal(models[2]?.emphasis, "quiet", "Idle Claude Logo is grey but remains clickable");
	assert.equal(models[4]?.emphasis, "quiet", "Idle New Chat must not stay lit without a RUNNING task");
	assert.equal(models[4]?.actionable, true, "Idle New Chat remains available even while visually quiet");
	assert.equal(models[4]?.detail, undefined);
	assert.equal(models[4]?.accent, "#7A9DFF");
	assert.ok(models.slice(5).every((model) => model.mutedDetail !== true), "A truly empty dashboard must not render stale secondary data");

	const running = task("codex", "running-model", "RUNNING", {
		reasoningEffort: "xhigh",
		model: "gpt-6-astra",
		progress: {
			...emptyTaskProgress(),
			latestActivity: { category: "shell", label: "Running tests", state: "running", at: now },
			todoCompleted: 2, todoTotal: 4, currentTodo: "Build package",
			activeSubagents: 1, totalSubagents: 3, turnStartedAt: now - 65_000, durationMs: 1_000,
		},
	});
	state.setSnapshot([running], { selectedTaskId: { codex: running.taskId, claude: null }, activeAgent: "codex" }, status);
	const runningModels = buildMainTileModels(state);
	assert.equal(estimateRemainingWork(state, [running]), undefined, "Insufficient observed runtime never creates an ETA");
	const measured = { ...running, progress: { ...running.progress, durationMs: 120_000 } };
	assert.equal(estimateRemainingWork(state, [measured]), 120_000);
	assert.equal(estimateRemainingWork(state, [measured, { ...measured, progress: { ...measured.progress, durationMs: 240_000 } }]), 240_000, "Parallel estimates use the longest remaining task");
	assert.equal(estimateRemainingWork(state, [{ ...measured, progress: { ...measured.progress, todoTotal: 0 } }]), undefined);
	assert.equal(runningModels[1]?.emphasis, "active");
	assert.equal(runningModels[1]?.actionable, true, "The focused Agent Logo opens its current conversation");
	assert.equal(runningModels[2]?.emphasis, "quiet", "Idle Claude stays grey while remaining available");
	assert.equal(runningModels[0]?.label, "XHIGH", "Selected conversation effort overrides the app default");
	assert.equal(runningModels[3]?.label, "REASONING", "The non-running Agent must not show its default reasoning level");
	assert.equal(runningModels[4]?.emphasis, "active", "New Chat lights when an Agent has a RUNNING task");
	assert.deepEqual(runningModels.map((model) => model.actionable), [true, true, true, false, true, false, false, false]);
	assert.equal(runningModels[5]?.detail, "Running tests");
	assert.equal(runningModels[0]?.detail, "GPT-6-ASTRA");
	assert.equal(runningModels[5]?.icon, "activity", "Activity keeps one stable pulse icon instead of swapping by tool category");
	assert.deepEqual(runningModels[5]?.process, { kind: "activity", value: "Running tests" });
	assert.equal(runningModels[6]?.detail, "2 / 4");
	assert.deepEqual(runningModels[6]?.process, { kind: "progress", completed: 2, total: 4, liveTaskCount: 1, unknownCount: 0 });
	assert.equal(runningModels[7]?.detail, "0S");
	assert.ok(runningModels.slice(5).every((model) => model.emphasis === "active" && model.mutedDetail !== true), "Live process cards remain visible");
	assert.ok(runningModels.slice(5).every((model) => model.accent === "#7A9DFF"), "All live Codex process cards use the same Codex blue");
	assert.ok(!runningModels[7]?.detail?.toLowerCase().includes("token"), "AGENTS shows child-agent count and turn duration, never token usage");

	for (const terminalStatus of ["DONE", "DONE_UNREAD", "ERROR", "PAUSED", "QUEUED", "STALE", "IDLE"] as const) {
		const terminal = task("codex", `terminal-${terminalStatus.toLowerCase()}`, terminalStatus, {
			progress: {
				...emptyTaskProgress(),
				latestActivity: { category: "thinking", label: "Thinking", state: terminalStatus === "ERROR" ? "error" : "done", at: now },
				todoCompleted: 2,
				todoTotal: 4,
				currentTodo: "Build package",
				activeSubagents: 0,
				totalSubagents: 3,
				turnStartedAt: now - 600_000,
				durationMs: 65_000,
			},
		});
		state.setSnapshot([terminal], { selectedTaskId: { codex: terminal.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
		const terminalModels = buildMainTileModels(state);
		assert.deepEqual(terminalModels.slice(5).map((model) => model.emphasis), ["quiet", "quiet", "active"], `${terminalStatus} process cards must not stay lit`);
		assert.ok(terminalModels.slice(5).every((model) => !model.actionable), `${terminalStatus} process cards remain inert`);
		assert.equal(terminalModels[5]?.mutedDetail, false, `${terminalStatus} preserves final Activity as neutral context`);
		assert.equal(terminalModels[6]?.mutedDetail, undefined, `${terminalStatus} never preserves stale per-task Todo progress`);
		assert.deepEqual(terminalModels.slice(5).map((model) => model.detail), ["Idle", "—", "0S"]);
	}

	const approval = task("claude", "approval-model", "APPROVAL");
	state.setSnapshot([approval], { selectedTaskId: { codex: null, claude: approval.taskId }, activeAgent: "claude" }, status);
	const approvalModels = buildMainTileModels(state);
	assert.equal(approvalModels[2]?.emphasis, "attention");
	assert.equal(approvalModels[2]?.badge, "1");
	assert.equal(approvalModels[4]?.emphasis, "quiet", "Approval attention must not light New Chat when no task is RUNNING");
	assert.deepEqual(approvalModels.map((model) => model.actionable), [false, true, true, false, true, false, false, false]);
	assert.equal(approvalModels[5]?.label, "ACTIVITY");
	assert.equal(approvalModels[6]?.label, "PROGRESS");
	assert.equal(approvalModels[7]?.label, "TODAY");
	assert.equal(approvalModels[7]?.emphasis, "active", "A blocked live task keeps its Agent process card visible");
	assert.equal(approvalModels[5]?.detail,"Idle");

	const waiting = task("codex", "waiting-model", "NEEDS_INPUT", {
		progress: {
			...emptyTaskProgress(),
			latestActivity: { category: "input", label: "Waiting for input", state: "waiting", at: now },
			todoCompleted: 1,
			todoTotal: 3,
			currentTodo: "Review answer",
		},
	});
	state.setSnapshot([waiting], { selectedTaskId: { codex: waiting.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
	assert.deepEqual(buildMainTileModels(state).slice(5).map(model => model.emphasis), ["quiet","quiet","active"], "Waiting tasks leave running progress while daily time stays visible");

	const codexApproval = task("codex", "approval-hold-model", "APPROVAL");
	state.setSnapshot([codexApproval], { selectedTaskId: { codex: codexApproval.taskId, claude: null }, activeAgent: "codex" }, status);
	const codexApprovalModels = buildMainTileModels(state);
	assert.ok(codexApprovalModels.slice(5).every((model) => !model.actionable), "Status cards remain inert even during approval");
	const riskyClaude = task("claude", "approval-risky-model", "APPROVAL", {
		request: { ...approval.request!, requestId: "risky-claude", riskTier: 2 },
	});
	assert.ok(buildMainTileModels(state).slice(5).every((model) => !model.actionable), "Risk tier cannot re-enable physical decision keys");

	const codexRunning = task("codex", "dual-codex", "RUNNING", {
		progress: { ...emptyTaskProgress(), latestActivity: { category: "shell", label: "Verify build", state: "running", at: now }, todoCompleted: 2, todoTotal: 4 },
	});
	const claudeRunning = task("claude", "dual-claude", "RUNNING", {
		progress: { ...emptyTaskProgress(), latestActivity: { category: "file", label: "Writing files", state: "running", at: now }, todoCompleted: 3, todoTotal: 4 },
	});
	const noPlanRunning = task("codex", "dual-no-plan", "RUNNING");
	const completedHistory = task("claude", "dual-history", "DONE", {
		progress: { ...emptyTaskProgress(), todoCompleted: 9, todoTotal: 9 },
	});
	state.setSnapshot([codexRunning, claudeRunning, noPlanRunning, completedHistory], { selectedTaskId: { codex: codexRunning.taskId, claude: claudeRunning.taskId }, activeAgent: "codex" }, status);
	const dualModels = buildMainTileModels(state);
	assert.equal(dualModels[1]?.actionable, true, "Current Agent Logo opens the current conversation");
	assert.equal(dualModels[2]?.actionable, true, "The other Agent Logo switches context and opens");
	assert.ok(dualModels.slice(5).every((model) => model.accent === "#7A9DFF"), "Simultaneous work follows the currently focused Codex task");
	assert.deepEqual(dualModels[6]?.process, { kind: "progress", completed: 5, total: 8, liveTaskCount: 3, unknownCount: 1 }, "Progress aggregates structured steps from every live task and excludes terminal history");
	assert.equal(dualModels[6]?.detail, "5 / 8");
	assert.deepEqual(dualModels[5]?.process, { kind: "activity", value: "Verify build" }, "Activity keeps the focused task state while showing the global live-task count");

	state.setSnapshot([codexRunning, claudeRunning, noPlanRunning, completedHistory], {
		selectedTaskId: { codex: codexRunning.taskId, claude: claudeRunning.taskId },
		activeAgent: "claude",
		newChatAgent: "claude",
	}, status);
	const claudeChatModels = buildMainTileModels(state);
	assert.equal(claudeChatModels[4]?.detail, undefined);
	assert.equal(claudeChatModels[4]?.accent, "#D97757", "Claude New Chat uses the Claude orange accent");
	assert.equal(claudeChatModels[7]?.accent,"#D97757", "Only the timer follows the selected agent");
	assert.equal(claudeChatModels[5]?.detail, "Verify build", "Claude focus exposes the Claude task's semantic Activity word");
	assert.deepEqual(claudeChatModels[6]?.process, { kind: "progress", completed: 5, total: 8, liveTaskCount: 3, unknownCount: 1 }, "Changing Agent color never changes the global aggregate Progress value");

	const safetyModels = buildMainTileModels(state, true);
	assert.ok(safetyModels.every((model) => model.emphasis === "quiet" && !model.actionable), "OFFLINE/SETUP support controls are weak and inert");
}

{
	const state = new DeviceState();
	const codex = task("codex", "plan", "NEEDS_INPUT", { lastEventAt: now + 1 });
	const input: PendingPlanInput = {
		requestId: "plan-request",
		taskId: codex.taskId,
		threadId: "thread-plan",
		turnId: "turn-plan",
		itemId: "item-plan",
		questionIndex: 0,
		questions: [{ id: "choice", header: "Mode", question: "Choose a mode", options: [{ label: "patch", description: "Apply a small patch" }, { label: "refactor", description: "Refactor the module" }] }],
	};
	state.setSnapshot([codex], { selectedTaskId: { codex: codex.taskId, claude: null }, activeAgent: "codex" }, status, [input]);
	assert.equal(state.getActivePlanInput()?.requestId, input.requestId);
	const planModels = buildMainTileModels(state);
	assert.equal(planModels[1]?.badge, "?");
	assert.equal(planModels[1]?.detail, "PLAN");
}

{
	const state = new DeviceState();
	const codex = task("codex", "fallback-question", "NEEDS_INPUT", { lastEventAt: now + 2 });
	state.setSnapshot([codex], { selectedTaskId: { codex: codex.taskId, claude: null }, activeAgent: "codex" }, status);
	const questionModels = buildMainTileModels(state);
	assert.equal(state.getActivePlanInput(), undefined, "Desktop fallback must not pretend it owns the app-server request");
	assert.equal(state.getAgentSummary("codex").needsInput, true);
	assert.equal(questionModels[0]?.label, "REASONING");
	assert.equal(questionModels[0]?.detail, undefined);
	assert.equal(questionModels[0]?.actionable, false);
	assert.equal(questionModels[1]?.badge, "?");
	assert.equal(questionModels[1]?.detail, "QUESTION");
}

{
	const state = new DeviceState();
	const first = task("codex", "first", "RUNNING", { startedAt: now - 2_000 });
	const second = task("codex", "second", "RUNNING", { startedAt: now - 1_000 });
	state.setSnapshot([first, second], { selectedTaskId: { codex: first.taskId, claude: null }, activeAgent: "codex" }, status);
	state.setSnapshot([second], { selectedTaskId: { codex: second.taskId, claude: null }, activeAgent: "codex" }, status);
	assert.equal(state.getDisplayTask("codex", 0).task, undefined, "Remaining live tasks do not jump position");
	assert.equal(state.getDisplayTask("codex", 1).task?.taskId, second.taskId);
	const replacement = task("codex", "replacement", "RUNNING", { startedAt: now });
	state.setSnapshot([second, replacement], { selectedTaskId: { codex: second.taskId, claude: null }, activeAgent: "codex" }, status);
	assert.equal(state.getDisplayTask("codex", 0).task?.taskId, replacement.taskId, "New live task takes the first released slot");
}

{
	const state = new DeviceState();
	const running = task("claude", "running", "RUNNING");
	const approval = task("claude", "approval", "APPROVAL");
	const input = task("claude", "input", "NEEDS_INPUT");
	const done = task("claude", "done", "DONE_UNREAD");
	const error = task("claude", "error", "ERROR");
	const paused = task("claude", "paused", "PAUSED");

	assert.deepEqual(state.getMainActionAvailability(running), { open: true, review: false, verify: false, openLabel: "OPEN" });
	assert.deepEqual(state.getMainActionAvailability(approval), { open: true, review: false, verify: false, openLabel: "OPEN" });
	assert.deepEqual(state.getMainActionAvailability(input), { open: true, review: false, verify: false, openLabel: "REPLY" });
	assert.deepEqual(state.getMainActionAvailability(done), { open: true, review: true, verify: true, openLabel: "OPEN" });
	assert.deepEqual(state.getMainActionAvailability(error), { open: true, review: true, verify: true, openLabel: "OPEN" });
	assert.equal(state.getMainActionAvailability(task("claude", "verifying", "ERROR", {
		workflow: { kind: "verify", state: "running", lastRunAt: now },
	})).verify, false, "VERIFY must be disabled while the same task is already being checked");
	assert.deepEqual(state.getMainActionAvailability(paused), { open: false, review: false, verify: false, openLabel: "OPEN" });
}

{
	const state = new DeviceState();
	const initial = task("codex", "decision", "APPROVAL");
	state.setSnapshot([initial], { selectedTaskId: { codex: initial.taskId, claude: null }, activeAgent: "codex" }, status);
	assert.equal(state.getAttentionGeneration(), 0, "Initial connection starts on Main without a synthetic event");
	state.setSnapshot([initial], { selectedTaskId: { codex: initial.taskId, claude: null }, activeAgent: "codex" }, status);
	assert.equal(state.getAttentionGeneration(), 0, "Repeated snapshot must not retrigger navigation");
	const newer = task("claude", "input", "NEEDS_INPUT", { attentionVersion: 2, lastEventAt: now + 1 });
	state.setSnapshot([initial, newer], { selectedTaskId: { codex: initial.taskId, claude: newer.taskId }, activeAgent: "claude" }, status);
	assert.equal(state.getAttentionGeneration(), 1);
	state.setOffline();
	state.setSnapshot([initial, newer], { selectedTaskId: { codex: initial.taskId, claude: newer.taskId }, activeAgent: "claude" }, status);
	assert.equal(state.getAttentionGeneration(), 1, "Reconnect with same versions must not jump again");
}

async function assertMainKeyDispatch(): Promise<void> {
	const ipcCalls: string[] = [];
	const actionCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const originalOpenAgent = daemonClient.sendOpenAgent;
	const originalActivateApp = daemonClient.sendActivateAgentApp;
	const originalNewChat = daemonClient.sendNewChat;
	const originalSelect = daemonClient.sendSelectTask;
	const originalAction = daemonClient.sendTaskAction;
	daemonClient.sendOpenAgent = async (agent) => { ipcCalls.push(`open:${agent}`); return true; };
	daemonClient.sendActivateAgentApp = async (agent) => { ipcCalls.push(`app:${agent}`); return true; };
	daemonClient.sendNewChat = async (agent) => { ipcCalls.push(`new:${agent}`); return true; };
	daemonClient.sendSelectTask = async () => { ipcCalls.push("select"); return true; };
	daemonClient.sendTaskAction = async (type, payload) => {
		ipcCalls.push(type);
		actionCalls.push({ type, payload: payload as unknown as Record<string, unknown> });
		return true;
	};
	try {
		deviceState.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
		const controller = new DeviceController() as unknown as {
			handleMainKey: (key: number) => Promise<void>;
			handleTaskKey: (key: number, agent: "codex" | "claude") => Promise<void>;
			handleDown: (control: { index: number }) => void;
			handleStateChange: () => void;
			lastAttentionGeneration: number;
			physicalPresses: Map<number, { key: number; baseSvg: string }>;
			feedback?: { message: string; detail?: string; success: boolean; expiresAt: number };
			localDecisions: Map<string, { accepted: boolean }>;
			deleteLocalDecision: (requestId: string) => void;
			clearFeedback: () => void;
			clearPhysicalPress: () => void;
		};
		for (let key = 0; key < 8; key += 1) await controller.handleMainKey(key);
		assert.deepEqual(ipcCalls, ["open:codex", "open:claude", "new:codex"], "Grey idle keys must produce zero actions");
		deviceState.setSnapshot([], {
			selectedTaskId: { codex: null, claude: null },
			activeAgent: null,
			newChatAgent: "claude",
		}, { ...status, runningTaskCount: 0 });
		await controller.handleMainKey(4);
		assert.equal(ipcCalls.at(-1), "new:claude", "The New Chat action follows the persisted Agent target");
		for (let key = 0; key < 8; key += 1) {
			await controller.handleTaskKey(key, "codex");
			await controller.handleTaskKey(key, "claude");
		}
		for (let key = 0; key < 8; key += 1) {
			controller.handleDown({ index: key });
			assert.equal(controller.physicalPresses.has(key), [1, 2, 4].includes(key), `Idle key ${key} actionability must match the fixed layout`);
			controller.clearPhysicalPress();
		}

		const running = task("codex", "running-press", "RUNNING");
		deviceState.setSnapshot([running], { selectedTaskId: { codex: running.taskId, claude: null }, activeAgent: "codex" }, status);
		controller.handleDown({ index: 1 });
		assert.equal(controller.physicalPresses.get(1)?.key, 1, "The focused Codex Logo remains an open button");
		controller.clearPhysicalPress();
		await controller.handleMainKey(1);
		assert.equal(ipcCalls.at(-1), "open:codex");
		controller.handleDown({ index: 3 });
		assert.equal(controller.physicalPresses.has(3), false, "Claude effort stays grey while Claude has no RUNNING task");
		controller.clearPhysicalPress();
		const claudeRunning = task("claude", "running-switch", "RUNNING");
		deviceState.setSnapshot([running, claudeRunning], { selectedTaskId: { codex: running.taskId, claude: claudeRunning.taskId }, activeAgent: "codex" }, status);
		controller.handleDown({ index: 3 });
		assert.equal(controller.physicalPresses.get(3)?.key, 3, "Claude effort animates only while Claude is running");
		controller.clearPhysicalPress();
		controller.handleDown({ index: 2 });
		assert.equal(controller.physicalPresses.get(2)?.key, 2, "A Logo that switches Agent context must animate");
		controller.clearPhysicalPress();
		controller.handleDown({ index: 0 });
		assert.equal(controller.physicalPresses.get(0)?.key, 0, "Codex effort button must start press feedback");
		controller.clearPhysicalPress();

		const codexApproval = task("codex", "approval-dispatch", "APPROVAL");
		deviceState.setSnapshot([codexApproval], { selectedTaskId: { codex: codexApproval.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
		const actionsBeforeStatusCards = actionCalls.length;
		for (const key of [5, 6, 7]) {
			controller.handleDown({ index: key });
			assert.equal(controller.physicalPresses.has(key), false, `Status card ${key} has no press action`);
			await controller.handleMainKey(key);
		}
		assert.equal(actionCalls.length, actionsBeforeStatusCards, "ACTIVITY / PROGRESS / AGENTS never send a device action");
		assert.equal(controller.feedback, undefined, "Status cards do not disguise hidden actions as feedback");

		const completed = task("codex", "completed-open", "DONE_UNREAD");
		deviceState.setSnapshot([completed], { selectedTaskId: { codex: completed.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
		controller.lastAttentionGeneration = deviceState.getAttentionGeneration();
		controller.handleDown({ index: 1 });
		const acceptedArtwork = controller.physicalPresses.get(1)?.baseSvg;
		assert.ok(acceptedArtwork?.includes(">CODEX<"), "CODEX freezes its accepted key artwork on key-down");
		const acknowledged = { ...completed, status: "DONE" as const, attentionCount: 0, acknowledgedAttentionVersion: completed.attentionVersion };
		deviceState.setSnapshot([acknowledged], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
		controller.handleStateChange();
		assert.equal(controller.physicalPresses.get(1)?.baseSvg, acceptedArtwork, "A successful CODEX open state update must not cancel its accepted press animation");
		controller.clearPhysicalPress();
		for (const requestId of controller.localDecisions.keys()) controller.deleteLocalDecision(requestId);
	} finally {
		daemonClient.sendOpenAgent = originalOpenAgent;
		daemonClient.sendActivateAgentApp = originalActivateApp;
		daemonClient.sendNewChat = originalNewChat;
		daemonClient.sendSelectTask = originalSelect;
		daemonClient.sendTaskAction = originalAction;
	}
}

{
	deviceState.setSnapshot([task("codex", "instant-press", "RUNNING")], { selectedTaskId: { codex: "codex-instant-press", claude: null }, activeAgent: "codex" }, status);
	const controller = new DeviceController() as unknown as {
		handleDown: (control: { index: number }) => void;
		physicalPresses: Map<number, { key: number; startedAt: number }>;
		pressProgress: (press: { key: number; startedAt: number }, now: number) => number;
		clearPhysicalPress: () => void;
	};
	controller.handleDown({ index: 0 });
	const press = controller.physicalPresses.get(0);
	assert.equal(press?.key, 0, "A valid key must enter physical press feedback on key-down before action acknowledgement");
	assert.ok(press && controller.pressProgress(press, press.startedAt) >= 0.25, "The first press frame must be visibly changed even at key-down time");
	controller.clearPhysicalPress();
}

type RenderTestController = {
	deck?: unknown;
	handleDown: (control: { index: number }) => void;
	releasePhysicalPress: (key: number) => void;
	requestRender: () => void;
	clearPhysicalPress: () => void;
	physicalPresses: Map<number, { firstFrameShownAt?: number }>;
	renderInProgress: boolean;
	lastFrame: Map<string, string>;
	renderTouchPoints: (deck: FakeDeck) => Promise<void>;
	renderLcd: (deck: FakeDeck) => Promise<boolean>;
	requestLcdRender: () => void;
	lcdAnimationTimer?: ReturnType<typeof setTimeout>;
	lcdContentKey?: string;
	lcdContentStartedAt: number;
	stop: () => Promise<void>;
};

async function assertTerminalInfobarTimerLifecycle(): Promise<void> {
	const controller = new DeviceController() as unknown as {
		scheduleTerminalInfobarExpiry: (expiresAt: number | undefined, now?: number) => void;
		terminalInfobarTimer?: ReturnType<typeof setTimeout>;
		terminalInfobarExpiresAt?: number;
		renderRequested: boolean;
		stop: () => Promise<void>;
	};
	const firstNow = Date.now();
	const firstExpiry = firstNow + 200;
	controller.scheduleTerminalInfobarExpiry(firstExpiry, firstNow);
	const originalTimer = controller.terminalInfobarTimer;
	controller.scheduleTerminalInfobarExpiry(firstExpiry, firstNow + 1);
	assert.equal(controller.terminalInfobarTimer, originalTimer, "Repeated snapshots with the same deadline reuse the exact expiry timer");

	const earlierNow = Date.now();
	const earlierExpiry = earlierNow + 20;
	controller.scheduleTerminalInfobarExpiry(earlierExpiry, earlierNow);
	assert.notEqual(controller.terminalInfobarTimer, originalTimer, "A different terminal deadline replaces the previous timer");
	await delay(30);
	assert.equal(controller.terminalInfobarTimer, undefined, "The terminal timer clears itself after requesting the expiry render");
	assert.equal(controller.terminalInfobarExpiresAt, undefined);
	assert.equal(controller.renderRequested, true, "The exact deadline requests an immediate frame instead of waiting for the 30-second ticker");

	const stopNow = Date.now();
	controller.scheduleTerminalInfobarExpiry(stopNow + 1_000, stopNow);
	await controller.stop();
	assert.equal(controller.terminalInfobarTimer, undefined, "Stopping the controller cancels the terminal expiry timer");
	assert.equal(controller.terminalInfobarExpiresAt, undefined);
}

class FakeDeck {
	readonly keyWrites: Array<{ key: number; at: number }> = [];
	readonly touchWrites: Array<{ key: number; rgb: readonly [number, number, number] }> = [];
	readonly lcdWrites: number[] = [];
	readonly firstWriteStarted: Promise<void>;
	private resolveFirstWriteStarted: () => void = () => undefined;
	private releaseBlockedWrite: (() => void) | undefined;

	constructor(private readonly blockFirstWrite = false) {
		this.firstWriteStarted = new Promise<void>((resolve) => { this.resolveFirstWriteStarted = resolve; });
	}

	async fillKeyBuffer(key: number): Promise<void> {
		this.keyWrites.push({ key, at: Date.now() });
		if (this.keyWrites.length !== 1) return;
		this.resolveFirstWriteStarted();
		if (this.blockFirstWrite) await new Promise<void>((resolve) => { this.releaseBlockedWrite = resolve; });
	}

	async fillKeyColor(key: number, red: number, green: number, blue: number): Promise<void> {
		this.touchWrites.push({ key, rgb: [red, green, blue] });
	}

	async fillLcd(): Promise<void> { this.lcdWrites.push(Date.now()); }
	async close(): Promise<void> {}
	releaseFirstWrite(): void { this.releaseBlockedWrite?.(); }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(message);
		await delay(2);
	}
}

async function assertUrgentPressPreemptsFullRefresh(): Promise<void> {
	const approval = task("codex", "priority-press", "APPROVAL");
	deviceState.setSnapshot([approval], { selectedTaskId: { codex: approval.taskId, claude: null }, activeAgent: "codex" }, status);
	const controller = new DeviceController() as unknown as RenderTestController;
	const deck = new FakeDeck(true);
	controller.deck = deck;
	controller.requestRender();
	await deck.firstWriteStarted;

	const downAt = Date.now();
	controller.handleDown({ index: 1 });
	await delay(35);
	const releasedAt = Date.now();
	deck.releaseFirstWrite();
	await waitFor(() => deck.keyWrites.length >= 2, "Urgent press frame was not written");
	await waitFor(() => controller.physicalPresses.get(1)?.firstFrameShownAt !== undefined, "Urgent press frame did not complete");
	assert.deepEqual(deck.keyWrites.slice(0, 2).map((write) => write.key), [0, 1], "A key-down must preempt the remaining full-page writes");
	const shownAt = controller.physicalPresses.get(1)?.firstFrameShownAt ?? Infinity;
	assert.ok(shownAt >= downAt, "The visible press timestamp must follow key-down");
	assert.ok(shownAt - releasedAt <= 100, "The first visible press frame must complete within 100ms after the in-flight HID write clears");

	controller.clearPhysicalPress();
	controller.deck = undefined;
	await waitFor(() => !controller.renderInProgress, "Priority render loop did not stop");
}

async function assertRapidPressesRemainIndependent(): Promise<void> {
	const approval = task("codex", "multi-press", "APPROVAL");
	deviceState.setSnapshot([approval], { selectedTaskId: { codex: approval.taskId, claude: null }, activeAgent: "codex" }, status);
	const controller = new DeviceController() as unknown as RenderTestController;
	const deck = new FakeDeck();
	controller.deck = deck;
	for (const key of [1, 2, 4]) controller.handleDown({ index: key });
	await waitFor(() => [1, 2, 4].every((key) => controller.physicalPresses.get(key)?.firstFrameShownAt !== undefined), "Rapid presses did not all render");
	assert.deepEqual(deck.keyWrites.slice(0, 3).map((write) => write.key), [1, 2, 4], "Rapid presses must retain per-key FIFO feedback");
	controller.releasePhysicalPress(2);
	assert.ok(controller.physicalPresses.has(1) && controller.physicalPresses.has(4), "Releasing one key must not cancel other key animations");

	controller.clearPhysicalPress();
	controller.deck = undefined;
	await waitFor(() => !controller.renderInProgress, "Multi-key render loop did not stop");
}

async function assertTouchPointWritesAreCached(): Promise<void> {
	deviceState.setSnapshot([], { selectedTaskId: { codex: null, claude: null }, activeAgent: null }, { ...status, runningTaskCount: 0 });
	const controller = new DeviceController() as unknown as RenderTestController;
	const deck = new FakeDeck();
	await controller.renderTouchPoints(deck);
	await controller.renderTouchPoints(deck);
	assert.deepEqual(deck.touchWrites, [
		{ key: 8, rgb: [0, 0, 0] },
		{ key: 9, rgb: [0, 0, 0] },
	], "Initial Touch Point colors are written once and cached");

	const running = task("codex", "touch-cache", "RUNNING");
	deviceState.setSnapshot([running], { selectedTaskId: { codex: running.taskId, claude: null }, activeAgent: "codex" }, status);
	await controller.renderTouchPoints(deck);
	assert.deepEqual(deck.touchWrites.at(-1), { key: 8, rgb: [122, 157, 255] }, "Only the changed Agent Touch Point is rewritten");
	assert.equal(deck.touchWrites.length, 3);
}

async function assertLcdMarqueeIsIndependent(): Promise<void> {
	const longRecap = task("codex", "lcd-marquee", "DONE_UNREAD", {
		lastEventAt: Date.now(),
		progress: {
			...emptyTaskProgress(),
			recap: "Completed an extraordinarily detailed verification of the internationalized Stream Deck Neo hardware interface.",
		},
	});
	deviceState.setSnapshot([longRecap], { selectedTaskId: { codex: longRecap.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
	const controller = new DeviceController() as unknown as RenderTestController;
	const deck = new FakeDeck();
	controller.deck = deck;
	assert.equal(await controller.renderLcd(deck), true);
	assert.equal(deck.lcdWrites.length, 1, "The initial long LCD frame is written once");
	assert.ok(controller.lcdAnimationTimer, "Overflowing LCD detail starts the animation scheduler");
	const contentKey = controller.lcdContentKey;
	controller.lcdContentStartedAt = Date.now() - 1_500;
	controller.requestLcdRender();
	await waitFor(() => deck.lcdWrites.length >= 2, "The LCD marquee did not render its moving frame");
	assert.equal(deck.keyWrites.length, 0, "LCD animation must never rewrite a hardware key");
	assert.equal(deck.touchWrites.length, 0, "LCD animation must never rewrite Touch Point LEDs");

	const shortRecap = { ...longRecap, taskId: "codex-lcd-short", externalId: "lcd-short", lastEventAt: Date.now(), progress: { ...longRecap.progress, recap: "Done." } };
	deviceState.setSnapshot([shortRecap], { selectedTaskId: { codex: shortRecap.taskId, claude: null }, activeAgent: "codex" }, { ...status, runningTaskCount: 0 });
	assert.equal(await controller.renderLcd(deck), true);
	assert.notEqual(controller.lcdContentKey, contentKey, "Changing LCD content resets the marquee identity");
	assert.equal(controller.lcdAnimationTimer, undefined, "Short LCD content stops the animation scheduler");
	await controller.stop();
	assert.equal(controller.lcdAnimationTimer, undefined, "Stopping the device cancels the LCD animation scheduler");
}

async function assertReleasedPressDoesNotReplayLate(): Promise<void> {
	const approval = task("codex", "stale-press", "APPROVAL");
	deviceState.setSnapshot([approval], { selectedTaskId: { codex: approval.taskId, claude: null }, activeAgent: "codex" }, status);
	const controller = new DeviceController() as unknown as RenderTestController;
	const deck = new FakeDeck(true);
	controller.deck = deck;
	controller.requestRender();
	await deck.firstWriteStarted;
	controller.handleDown({ index: 1 });
	controller.releasePhysicalPress(1);
	assert.equal(controller.physicalPresses.has(1), false, "A released, never-shown press must be discarded");
	deck.releaseFirstWrite();
	await waitFor(() => deck.keyWrites.some((write) => write.key === 1), "Released key was not restored");
	await waitFor(() => controller.lastFrame.has("key:1"), "Released key frame did not complete");
	assert.ok(!controller.lastFrame.get("key:1")?.includes('data-pressed="true"'), "A stale press frame must not appear after key-up");

	controller.clearPhysicalPress();
	controller.deck = undefined;
	await waitFor(() => !controller.renderInProgress, "Stale-frame render loop did not stop");
}

void (async () => {
	await assertMainKeyDispatch();
	await assertUrgentPressPreemptsFullRefresh();
	await assertRapidPressesRemainIndependent();
	await assertReleasedPressDoesNotReplayLate();
	await assertTouchPointWritesAreCached();
	await assertLcdMarqueeIsIndependent();
	await assertTerminalInfobarTimerLifecycle();
	console.log("[device-regression] independent LCD marquee, inert progress cards, Touch Points and priority press feedback: ok");
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
