import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "acorn";
import { BoundedJsonlReader } from "./bounded-jsonl.js";
import { normalizeReasoningEffort, redactSensitiveText, type ActivityCategory, type AdapterStatus, type ReasoningEffort, type RiskTier, type Task, type TaskProgress, type TaskStatus } from "@streamdeck-supervisor/shared";
import type { AdapterContext, SupervisorAdapter } from "./types.js";
import { baseTask, projectLabelFromCwd, safeTaskTitle } from "./types.js";
import { reduceProgressEvents, safeProgressText, type ProgressEvent } from "../progress-reducer.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_THREADS = 64;
const MAX_TITLE_SCAN_BYTES = 16 * 1024 * 1024;
const LIFECYCLE_SCAN_CHUNK_BYTES = 64 * 1024;
const ROLLOUT_OVERLAP_BYTES = 64 * 1024;
const APPROVAL_LEASE_MS = 15_000;
const COMPUTER_USE_APPROVAL_GRACE_MS = 1_000;
const MAX_PROGRAMMATIC_SOURCE_BYTES = 256 * 1024;

interface RolloutParseState {
	identity: string;
	cursor: number;
	mtimeMs: number;
	ctimeMs: number;
	latestUserText?: string;
	reader?: BoundedJsonlReader;
	overlap: string;
	status?: TaskStatus;
	lastEventAt: number;
	lastExecutionActivityAt: number;
	executionId?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	pendingUserInputCalls: Set<string>;
	pendingApprovalCalls: Map<string, CodexPendingApproval>;
	pendingComputerUseCalls: Map<string, PendingComputerUseApproval>;
	observedComputerUseApps: Set<string>;
	progressEvents: ProgressEvent[];
	recordSequence: number;
	toolByCallId: Map<string, ToolActivityDescriptor>;
}

interface ToolActivityDescriptor {
	category: ActivityCategory;
	label: string;
}

export class RolloutReader {
 readonly states = new Map<string, RolloutParseState>();
 read(filePath: string, previousUserText?: string, previousExecutionId?: string, apps: ReadonlySet<string> = new Set()) {
  return lifecycleFromRollout(filePath, previousUserText, previousExecutionId, apps, this);
 }
 retain(paths: ReadonlySet<string>): void {
  for (const key of this.states.keys()) if (!paths.has(key)) this.states.delete(key);
 }
 clear(): void { this.states.clear(); }
}
// Compatibility for one-shot callers; running adapters each own their reader.
const standaloneReader = new RolloutReader();

interface ThreadRow {
	id: string;
	rollout_path: string;
	created_at: number;
	updated_at: number;
	created_at_ms: number | null;
	updated_at_ms: number | null;
	source: string;
	thread_source: string | null;
	agent_role: string | null;
	cwd: string;
	title: string;
	first_user_message: string;
	preview: string;
	name: string | null;
	has_user_event: number;
	archived: number;
	reasoning_effort: string | null;
}

export class CodexCatalogAdapter implements SupervisorAdapter {
	readonly name = "codex" as const;
	private readonly stateDirectory: string;
	private timer: ReturnType<typeof setInterval> | undefined;
	private status: AdapterStatus = { status: "OFFLINE", lastPollAt: 0 };
	private readonly rollouts = new RolloutReader();

	constructor(
		private readonly context: AdapterContext,
		stateDirectory?: string,
		private readonly isApprovalControlReady: () => boolean = () => false,
		private readonly isStopControlReady: () => boolean = () => false,
		private readonly isManagedThread: (threadId: string) => boolean = () => false,
	) {
		this.stateDirectory = stateDirectory ?? path.join(os.homedir(), ".codex");
	}

	getStatus(): AdapterStatus { return { ...this.status }; }

	async start(): Promise<void> {
		await this.poll();
		this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.rollouts.clear();
	}

	private async poll(): Promise<void> {
		try {
			const databasePath = latestStateDatabase(this.stateDirectory);
			if (!databasePath) throw new Error(`No Codex state database found under ${this.stateDirectory}`);
			const rows = readThreads(databasePath);
			const childRowsByParent = indexDirectChildThreads(rows);
			const visible = rows.filter((row) => isVisibleThread(row) && !this.isManagedThread(row.id)).slice(0, MAX_THREADS);
			const retained = new Set<string>();
			for (const row of visible) {
				retained.add(row.rollout_path);
				const children = childRowsByParent.get(row.id) ?? [];
				for (const child of children) retained.add(child.rollout_path);
				const previous = this.context.registry.getTask(`codex:${row.id}`);
				const parsed = this.rollouts.read(row.rollout_path, undefined, previous?.executionId);
				const lifecycle = { ...parsed, progress: progressWithDirectChildren(parsed.progress, children, this.rollouts) };
				this.context.upsertTask(taskFromThread(row, lifecycle, this.isApprovalControlReady(), this.isStopControlReady()));
			}
			this.rollouts.retain(retained);
			this.setStatus("OK");
		} catch (error) {
			this.setStatus("DEGRADED", error instanceof Error ? error.message : String(error));
		}
	}

	private setStatus(status: AdapterStatus["status"], lastError?: string): void {
		this.status = { status, lastPollAt: Date.now(), ...(lastError ? { lastError } : {}) };
		this.context.setStatus(this.name, status, lastError);
	}
}

function latestStateDatabase(directory: string): string | null {
	try {
		return fs.readdirSync(directory)
			.filter((name) => /^state_\d+\.sqlite$/.test(name))
			.map((name) => path.join(directory, name))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
	} catch { return null; }
}

export function readThreads(databasePath: string): ThreadRow[] {
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const columns = new Set((database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name));
		for (const required of ["id", "rollout_path", "cwd", "title", "source", "archived"]) {
			if (!columns.has(required)) throw new Error(`Unsupported Codex database: missing threads.${required}`);
		}
		const reasoningEffortColumn = columns.has("reasoning_effort") ? "reasoning_effort" : "NULL AS reasoning_effort";
		// Sort only row identities; never sort/copy full prompts into temporary rows.
		return database.prepare(`
			WITH recent AS MATERIALIZED (
			 SELECT rowid AS rid FROM threads WHERE archived = 0
			 ORDER BY COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC LIMIT 256
			)
			SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
			       source, thread_source, agent_role, cwd,
			       substr(title,1,1024) AS title, substr(first_user_message,1,1024) AS first_user_message,
			       substr(preview,1,1024) AS preview, name, has_user_event, archived, ${reasoningEffortColumn}
			FROM recent JOIN threads ON threads.rowid = recent.rid
			ORDER BY COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC
		`).all() as unknown as ThreadRow[];
	} finally { database.close(); }
}

function indexDirectChildThreads(rows: readonly ThreadRow[]): Map<string, ThreadRow[]> {
	const indexed = new Map<string, ThreadRow[]>();
	for (const row of rows) {
		const parentThreadId = directParentThreadId(row);
		if (!parentThreadId) continue;
		const children = indexed.get(parentThreadId) ?? [];
		children.push(row);
		indexed.set(parentThreadId, children);
	}
	return indexed;
}

function directParentThreadId(row: ThreadRow): string | undefined {
	if (row.thread_source !== "subagent" && !/subagent/i.test(row.source ?? "")) return undefined;
	try {
		const source = objectValue(JSON.parse(row.source));
		const subagent = objectValue(source?.subagent);
		const spawn = objectValue(subagent?.thread_spawn);
		return stringValue(spawn?.parent_thread_id);
	} catch {
		return undefined;
	}
}

/**
 * Observer mode has no live collab event stream. The Codex catalog is the
 * authoritative parent/child topology, while each child rollout owns its
 * actual turn lifecycle. Only direct children active in the parent's latest
 * turn contribute to the card.
 */
function progressWithDirectChildren(progress: TaskProgress, childRows: readonly ThreadRow[], reader: RolloutReader): TaskProgress {
	const parentTurnStartedAt = progress.turnStartedAt;
	if (!parentTurnStartedAt || childRows.length === 0) {
		return { ...progress, activeSubagents: 0, totalSubagents: 0 };
	}
	const total = new Set<string>();
	const active = new Set<string>();
	for (const row of childRows) {
		const child = reader.read(row.rollout_path, "Subagent");
		const createdAt = row.created_at_ms ?? row.created_at * 1_000;
		const childTurnStartedAt = child.progress.turnStartedAt ?? createdAt;
		if (Math.max(createdAt, childTurnStartedAt) < parentTurnStartedAt) continue;
		total.add(row.id);
		if (child.status === "RUNNING" || child.status === "APPROVAL" || child.status === "NEEDS_INPUT") active.add(row.id);
	}
	return { ...progress, activeSubagents: active.size, totalSubagents: total.size };
}

function isVisibleThread(row: ThreadRow): boolean {
	if (row.archived || !row.id || !row.cwd) return false;
	const source = `${row.source ?? ""} ${row.thread_source ?? ""} ${row.agent_role ?? ""}`;
	if (/subagent|guardian/i.test(source)) return false;
	return Boolean((row.name ?? "").trim() || row.title.trim() || row.preview.trim() || row.first_user_message.trim());
}

function taskFromThread(
	row: ThreadRow,
	lifecycle: ReturnType<typeof lifecycleFromRollout>,
	approvalControlReady: boolean,
	stopControlReady: boolean,
): Task {
	const updatedAt = lifecycle.lastEventAt || row.updated_at_ms || row.updated_at * 1000 || Date.now();
	const startedAt = row.created_at_ms || row.created_at * 1000 || updatedAt;
	const title = row.name || lifecycle.latestUserText || row.title || row.preview || row.first_user_message || "Codex task";
	const task = baseTask("codex", {
		taskId: `codex:${row.id}`,
		executionId: lifecycle.executionId,
		externalId: row.id,
		projectId: row.cwd,
		projectLabel: projectLabelFromCwd(row.cwd, "CODEX"),
		cwd: row.cwd,
		titleShort: safeTaskTitle(title, "Codex task"),
		reasoningEffort: lifecycle.reasoningEffort ?? normalizeReasoningEffort(row.reasoning_effort),
		model: lifecycle.model,
		status: lifecycle.status,
		lastEventAt: updatedAt,
		lastObservedAt: Date.now(),
		lastExecutionActivityAt: lifecycle.lastExecutionActivityAt,
		startedAt,
		source: "catalog-sqlite",
		openRef: { kind: "url", value: `codex://threads/${encodeURIComponent(row.id)}` },
	}, {
		approve: approvalControlReady && !!lifecycle.approval,
		reject: approvalControlReady && !!lifecycle.approval,
		interrupt: lifecycle.status === "RUNNING" && !!lifecycle.executionId && stopControlReady,
		review: true,
		verify: true,
	});
	task.progress = lifecycle.progress;
	if (lifecycle.approval) {
		task.request = {
			requestId: `codex:${row.id}:${lifecycle.approval.callId}`,
			type: "permission",
			target: lifecycle.approval.target,
			riskTier: lifecycle.approval.riskTier,
			createdAt: lifecycle.approval.createdAt,
			// The adapter renews this short lease every poll while the exact call is
			// still unmatched. A stopped/degraded adapter therefore cannot leave a
			// bright approval key behind.
			expiresAt: Date.now() + APPROVAL_LEASE_MS,
			decisionPath: "codex-shortcut",
		};
	}
	return task;
}

export function readCodexDefaultReasoningEffort(stateDirectory = path.join(os.homedir(), ".codex")): ReasoningEffort | undefined {
	try {
		const config = fs.readFileSync(path.join(stateDirectory, "config.toml"), "utf8");
		const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1];
		return normalizeReasoningEffort(value);
	} catch {
		return undefined;
	}
}

export interface CodexPendingApproval {
	callId: string;
	target: string;
	riskTier: RiskTier;
	createdAt: number;
}

interface PendingComputerUseApproval extends CodexPendingApproval {
	appKey: string;
	matchKey: string;
}

interface ComputerUseDescriptor {
	appKey: string;
	appLabel: string;
	matchKey: string;
}

export function lifecycleFromRollout(
	filePath: string,
	previousUserText?: string,
	previousExecutionId?: string,
	previousComputerUseApps: ReadonlySet<string> = new Set(),
	reader: RolloutReader = standaloneReader,
): {
	status: TaskStatus;
	lastEventAt: number;
	lastExecutionActivityAt: number;
	executionId?: string;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	latestUserText?: string;
	approval?: CodexPendingApproval;
	observedComputerUseApps: string[];
	progress: TaskProgress;
} {
	try {
		const stat = fs.statSync(filePath);
		let state = reusableRolloutState(filePath, stat, reader);
		if (!state) {
			const start = latestLifecycleBoundaryOffset(filePath, stat.size);
			state = newRolloutState(stat, previousExecutionId, previousComputerUseApps);
			state.latestUserText = previousUserText;
			consumeRolloutRange(state, filePath, start, stat.size, stat.mtimeMs);
			if (!state.latestUserText) state.latestUserText = readLatestUserText(filePath, stat.size);
			reader.states.set(filePath, state);
			if (reader === standaloneReader && reader.states.size > 256) reader.states.delete(reader.states.keys().next().value!);
		} else {
			for (const app of previousComputerUseApps) state.observedComputerUseApps.add(app);
			if (stat.size > state.cursor) consumeRolloutRange(state, filePath, state.cursor, stat.size, stat.mtimeMs);
		}
		if (state.cursor !== stat.size) state.overlap = rolloutOverlap(filePath, stat.size);
		state.cursor = stat.size;
		state.mtimeMs = stat.mtimeMs;
		state.ctimeMs = stat.ctimeMs;
		state.executionId ??= previousExecutionId;

		const selectedApproval = [...state.pendingApprovalCalls.values()].sort((a,b) => b.createdAt-a.createdAt)[0];
		const approval = selectedApproval ? {
			callId: selectedApproval.callId,
			target: selectedApproval.target,
			riskTier: selectedApproval.riskTier,
			createdAt: selectedApproval.createdAt,
		} : undefined;
		const status = approval ? "APPROVAL" : state.pendingUserInputCalls.size > 0 ? "NEEDS_INPUT" : state.status;
		return {
			status: status ?? "IDLE",
			lastEventAt: approval?.createdAt ?? state.lastEventAt,
			lastExecutionActivityAt: state.lastExecutionActivityAt,
			...(state.executionId ? { executionId: state.executionId } : {}),
			latestUserText: state.latestUserText,
			model: state.model,
			reasoningEffort: state.reasoningEffort,
			...(approval ? { approval } : {}),
			observedComputerUseApps: [...state.observedComputerUseApps],
			progress: reduceProgressEvents(state.progressEvents, Date.now()).progress,
		};
	} catch {
		return {
			status: "STALE" as const,
			lastEventAt: 0,
			lastExecutionActivityAt: 0,
			observedComputerUseApps: [...previousComputerUseApps],
			progress: reduceProgressEvents([], Date.now()).progress,
		};
	}
}

interface RolloutRecord {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		role?: string;
		message?: string;
		name?: string;
		call_id?: string;
		turn_id?: string;
		model?: string;
		phase?: string;
		effort?: string;
		input?: string;
		arguments?: string;
		output?: unknown;
		invocation?: unknown;
		result?: unknown;
		content?: Array<{ type?: string; text?: string }>;
		plan?: Array<{ step?: string; status?: string }>;
	};
}

function isElevatedExec(input: unknown): input is string {
	return typeof input === "string"
		&& /(?:^|[,{]\s*)["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/i.test(input);
}

function elevatedExecTarget(input: string): string {
	return extractStringArgument(input, "justification")
		?? extractStringArgument(input, "cmd")
		?? "Codex elevated command";
}

function elevatedExecRisk(input: string): RiskTier {
	const target = `${extractStringArgument(input, "cmd") ?? ""} ${extractStringArgument(input, "justification") ?? ""}`;
	const dangerous = /(^|\s)(sudo|rm\s+-rf|dd\s+if=|chmod\s+777)(\s|$)|git\s+push\s+--force|\|\s*(sh|bash|zsh)\b/i;
	const external = /\b(curl|wget|ssh|scp|rsync)\b|https?:\/\//i;
	return dangerous.test(target) || external.test(target) ? 2 : 1;
}

function computerUseDescriptorFromExec(input: unknown): ComputerUseDescriptor | undefined {
	if (typeof input !== "string" || !/\btools\.mcp__node_repl__js\s*\(/.test(input)) return undefined;
	const title = extractStringArgument(input, "title") ?? "Computer Use";
	const code = extractStringArgument(input, "code");
	return computerUseDescriptor(title, code);
}

function computerUseDescriptorFromMcpEnd(payload: RolloutRecord["payload"]): ComputerUseDescriptor | undefined {
	const invocation = objectValue(payload?.invocation);
	if (stringValue(invocation?.server) !== "node_repl" || stringValue(invocation?.tool) !== "js") return undefined;
	const argumentsValue = objectValue(invocation?.arguments);
	return computerUseDescriptor(stringValue(argumentsValue?.title) ?? "Computer Use", stringValue(argumentsValue?.code));
}

function computerUseDescriptor(title: string, code: string | undefined): ComputerUseDescriptor | undefined {
	if (!code || !/(?:@oai\/sky|\bsky\s*\.)/.test(code)) return undefined;
	const appLabel = extractStringArgument(code, "app")?.trim();
	if (!appLabel) return undefined;
	return {
		appKey: appLabel.toLocaleLowerCase("en-US"),
		appLabel,
		matchKey: `${title}\u0000${code}`,
	};
}

function isRunningExecOutput(output: unknown): boolean {
	return typeof output === "string" && /^Script running with cell ID\s+\S+/m.test(output);
}

function mcpToolCallSucceeded(result: unknown): boolean {
	return !!result && typeof result === "object" && !Array.isArray(result)
		&& Object.prototype.hasOwnProperty.call(result, "Ok");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractStringArgument(input: string, key: string): string | undefined {
	const match = new RegExp(`(?:^|[,{]\\s*)["']?${key}["']?\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, "s").exec(input)?.[1];
	if (!match) return undefined;
	try {
		if (match.startsWith('"')) return JSON.parse(match) as string;
		return match.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function newRolloutState(
	stat: fs.Stats,
	previousExecutionId: string | undefined,
	previousComputerUseApps: ReadonlySet<string>,
): RolloutParseState {
	return {
		identity: rolloutIdentity(stat),
		cursor: 0,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		overlap: "",
		lastEventAt: 0,
		lastExecutionActivityAt: 0,
		...(previousExecutionId ? { executionId: previousExecutionId } : {}),
		pendingUserInputCalls: new Set(),
		pendingApprovalCalls: new Map(),
		pendingComputerUseCalls: new Map(),
		observedComputerUseApps: new Set(previousComputerUseApps),
		progressEvents: [],
		recordSequence: 0,
		toolByCallId: new Map(),
	};
}

function reusableRolloutState(filePath: string, stat: fs.Stats, reader: RolloutReader): RolloutParseState | undefined {
	const state = reader.states.get(filePath);
	if (!state || state.identity !== rolloutIdentity(stat) || stat.size < state.cursor) return undefined;
	if (stat.size === state.cursor) return stat.mtimeMs === state.mtimeMs && stat.ctimeMs === state.ctimeMs ? state : undefined;
	if (state.cursor > 0 && rolloutOverlap(filePath, state.cursor) !== state.overlap) return undefined;
	return state;
}

function rolloutIdentity(stat: fs.Stats): string {
	return `${stat.dev}:${stat.ino}`;
}

function consumeRolloutBytes(state: RolloutParseState, bytes: Buffer, fallbackAt: number): void {
 state.reader ??= new BoundedJsonlReader(line => applyRolloutLine(state, line, state.mtimeMs));
 state.mtimeMs = fallbackAt;
 state.reader.write(bytes);
}

function consumeRolloutRange(state: RolloutParseState, filePath: string, start: number, end: number, fallbackAt: number): void {
	if (end <= start) return;
	const handle = fs.openSync(filePath, "r");
	const buffer = Buffer.alloc(Math.min(LIFECYCLE_SCAN_CHUNK_BYTES, end - start));
	let position = start;
	try {
		while (position < end) {
			const length = Math.min(buffer.length, end - position);
			const bytesRead = fs.readSync(handle, buffer, 0, length, position);
			if (bytesRead <= 0) break;
			consumeRolloutBytes(state, buffer.subarray(0, bytesRead), fallbackAt);
			position += bytesRead;
		}
	} finally {
		fs.closeSync(handle);
	}
}

function applyRolloutLine(state: RolloutParseState, rawLine: string, fallbackAt: number): void {
	const line = rawLine.trim();
	if (!line) return;
	state.recordSequence += 1;
	try {
		const record = JSON.parse(line) as RolloutRecord;
		const title = userTextFromRecord(record);
		if (title) state.latestUserText = preferUserTitle(state.latestUserText, title);
		applyRolloutRecord(state, record, fallbackAt, state.recordSequence);
		compactProgress(state);
	} catch { /* A malformed complete record cannot safely change approval state. */ }
}

function applyRolloutRecord(state: RolloutParseState, record: RolloutRecord, fallbackAt: number, sequence: number): void {
	if (record.type === "turn_context") {
		state.model = stringValue(record.payload?.model) ?? state.model;
		state.reasoningEffort = normalizeReasoningEffort(record.payload?.effort) ?? state.reasoningEffort;
	}
	if (record.payload && record.payload.input === undefined) record.payload.input = record.payload.arguments;
	const occurredAt = record.timestamp ? Date.parse(record.timestamp) || fallbackAt : fallbackAt;
	const turnId = stringValue(record.payload?.turn_id) ?? state.executionId ?? "current";
	const eventId = (suffix: string) => `codex:${turnId}:${sequence}:${suffix}`;
	// Only execution records renew liveness. In particular, thread_settings_applied,
	// file mtime and repeatedly reading the same bytes say nothing about a live turn.
	const eventType = record.payload?.type ?? "";
	if ((record.type === "event_msg" && /^(task_started|task_complete|turn_aborted|turn_completed|turn_failed|error|agent_message|agent_reasoning|item_started|item_completed|token_count|mcp_tool_call_begin|mcp_tool_call_end|request_user_input|needs_input|user_input_required)$/.test(eventType))
		|| record.type === "token_usage_record"
		|| (record.type === "response_item" && /^(message|reasoning|function_call|custom_tool_call|function_call_output|custom_tool_call_output)$/.test(eventType))) {
		state.lastExecutionActivityAt = Math.max(state.lastExecutionActivityAt, occurredAt);
	}
	if (record.type === "event_msg") {
		const event = eventType === "turn_completed" ? "task_complete" : eventType === "turn_failed" ? "error" : eventType;
		const eventTurnId = stringValue(record.payload?.turn_id);
		if (event === "task_started") {
			state.progressEvents = [{ id: eventId("start"), at: occurredAt, turnId: eventTurnId ?? turnId, type: "turn.started" }];
			state.toolByCallId.clear();
		}
		if (event === "task_complete" || event === "turn_aborted" || /error|fail/.test(event)) {
			state.toolByCallId.clear();
			state.progressEvents.push({
				id: eventId("terminal"),
				at: occurredAt,
				turnId: eventTurnId ?? turnId,
				type: "turn.terminal",
				terminal: event === "task_complete" ? "completed" : event === "turn_aborted" ? "interrupted" : "error",
			});
		}
		if (event === "agent_message" && stringValue(record.payload?.message)) {
			state.progressEvents.push({ id: eventId("recap"), at: occurredAt, turnId, type: "recap", text: record.payload!.message! });
		}
		if (event === "mcp_tool_call_end") {
			const computerUse = computerUseDescriptorFromMcpEnd(record.payload);
			if (computerUse) {
				const resolved = [...state.pendingComputerUseCalls.entries()]
					.find(([, candidate]) => candidate.matchKey === computerUse.matchKey);
				if (resolved) state.pendingComputerUseCalls.delete(resolved[0]);
				if (mcpToolCallSucceeded(record.payload?.result)) state.observedComputerUseApps.add(computerUse.appKey);
				if (resolved) {
					state.status = "RUNNING";
					state.lastEventAt = occurredAt;
				}
			}
			return;
		}
		if (eventTurnId && (event === "task_started" || event === "task_complete" || event === "turn_aborted")) state.executionId = eventTurnId;
		if (event === "task_started" || event === "task_complete" || event === "turn_aborted" || /error|fail/.test(event)) {
			state.pendingUserInputCalls.clear();
			state.pendingApprovalCalls.clear();
			state.pendingComputerUseCalls.clear();
			state.status = event === "task_started" ? "RUNNING" : event === "task_complete" ? "DONE_UNREAD" : event === "turn_aborted" ? "PAUSED" : "ERROR";
			state.lastEventAt = occurredAt;
		} else if (/^(request_user_input|needs_input|user_input_required)$/.test(event)) {
			state.status = "NEEDS_INPUT";
			state.lastEventAt = occurredAt;
		}
		return;
	}
	if (record.type !== "response_item") return;
	const payload = record.payload;
	const callId = stringValue(payload?.call_id);
	const itemType = stringValue(payload?.type) ?? "";
	const toolName = stringValue(payload?.name);
	if ((itemType === "function_call" || itemType === "custom_tool_call") && toolName) {
		const activity = itemType === "custom_tool_call" && toolName === "exec"
			? programmaticExecActivity(payload?.input)
			: activityDescriptorForTool(toolName);
		if (activity.category === "file" && typeof payload?.input === "string") {
			const file = extractStringArgument(payload.input, "path") ?? extractStringArgument(payload.input, "file_path");
			if (file) activity.label = `${/read|view/i.test(activity.label) ? "Reading" : "Editing"} ${redactSensitiveText(path.basename(file))}`;
		}
		if (callId) state.toolByCallId.set(callId, activity);
		state.progressEvents.push({
			id: eventId(`tool:${callId ?? sequence}`), at: occurredAt, turnId, type: "activity",
			category: activity.category, label: activity.label, state: "running",
		});
		if (/update_plan|taskupdate|todowrite/i.test(toolName)) {
			const items = planItemsFromInput(payload?.input);
			if (items.length > 0 || hasPlanInput(payload?.input)) state.progressEvents.push({ id: eventId("todo"), at: occurredAt, turnId, type: "todo", items });
		}
		if (itemType === "custom_tool_call" && toolName === "exec") {
			for (const [index, input] of programmaticPlanInputs(payload?.input).entries()) {
				const items = planItemsFromInput(input);
				if (items.length > 0 || hasPlanInput(input)) state.progressEvents.push({
					id: eventId(`programmatic-todo:${index}`), at: occurredAt + index / 1_000, turnId, type: "todo", items,
				});
			}
		}
	}
	if ((itemType === "function_call_output" || itemType === "custom_tool_call_output") && callId) {
		const completedTool = state.toolByCallId.get(callId) ?? { category: "other" as const, label: "Working" };
		if (!isRunningExecOutput(payload?.output)) state.toolByCallId.delete(callId);
		state.progressEvents.push({
			id: eventId(`tool-output:${callId}`), at: occurredAt, turnId, type: "activity",
			category: completedTool.category, label: completedTool.label, state: "done",
		});
	}
	if ((itemType === "message" || itemType === "agent_message") && payload?.role === "assistant") {
		const text = payload.content?.map((item) => item.text ?? "").join(" ").trim() || stringValue(payload.message);
		if (text) state.progressEvents.push({ id: eventId("recap"), at: occurredAt, turnId, type: "recap", text });
		if (payload.phase === "final_answer") {
			state.status = "DONE_UNREAD";
			state.lastEventAt = occurredAt;
			state.pendingUserInputCalls.clear();
			state.pendingApprovalCalls.clear();
			state.pendingComputerUseCalls.clear();
			state.progressEvents.push({ id: eventId("final-answer"), at: occurredAt, turnId, type: "turn.terminal", terminal: "completed" });
		}
	}
	if (itemType === "reasoning") {
		state.progressEvents.push({ id: eventId("thinking"), at: occurredAt, turnId, type: "activity", category: "thinking", label: "Thinking", state: "running" });
	}
	if (/(?:^|__|\.)request_user_input$/.test(payload?.name ?? "") && callId) {
		state.progressEvents.push({ id: eventId(`input:${callId}`), at: occurredAt, turnId, type: "input", label: "Waiting for answer" });
		state.pendingUserInputCalls.add(callId);
		state.status = "NEEDS_INPUT";
		state.lastEventAt = occurredAt;
		return;
	}

	if (payload?.type === "custom_tool_call" && payload.name === "exec" && callId) {
		const computerUse = computerUseDescriptorFromExec(payload.input);
		if (computerUse && !state.observedComputerUseApps.has(computerUse.appKey)) {
			state.pendingComputerUseCalls.set(callId, {
				callId,
				target: `Computer Use · ${computerUse.appLabel}`,
				riskTier: 1,
				createdAt: occurredAt,
				appKey: computerUse.appKey,
				matchKey: computerUse.matchKey,
			});
		}
		return;
	}
	if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && callId) {
		const resolvedInput = state.pendingUserInputCalls.delete(callId);
		const resolvedApproval = state.pendingApprovalCalls.delete(callId);
		const resolvedComputerUse = !isRunningExecOutput(payload.output) && state.pendingComputerUseCalls.delete(callId);
		if (resolvedInput || resolvedApproval || resolvedComputerUse) {
			state.status = "RUNNING";
			state.lastEventAt = occurredAt;
		}
	}
}

function activityDescriptorForTool(name: string): ToolActivityDescriptor {
	const normalized = name.toLowerCase();
	if (/request_user_input|question|needs_input/.test(normalized)) return { category: "input", label: "Waiting for answer" };
	if (/update_plan|todo|taskcreate|taskupdate/.test(normalized)) return { category: "plan", label: "Updating plan" };
	if (/imagegen|image_gen|generate_image/.test(normalized)) return { category: "image", label: "Generating image" };
	if (/view_image|image_view/.test(normalized)) return { category: "file", label: "Viewing image" };
	if (/exec_command|write_stdin|(?:^|__|_|-)wait|terminal|command|shell|bash/.test(normalized)) return { category: "shell", label: "Running command" };
	if (/apply_patch|(?:^|__|_|-)edit|(?:^|__|_|-)write/.test(normalized)) return { category: "file", label: "Editing files" };
	if (/(?:^|__|_|-)(?:read|list|glob)|file/.test(normalized)) return { category: "file", label: "Reading files" };
	if (/web__run|search|grep|find/.test(normalized)) return { category: "search", label: "Searching web" };
	if (/browser|computer|chrome|playwright/.test(normalized)) return { category: "browser", label: "Using browser" };
	if (/agent|collab|spawn|task$/.test(normalized)) return { category: "agent", label: "Working with agent" };
	return { category: "other", label: "Working" };
}

function activityDescriptorForCategory(category: ToolActivityDescriptor["category"]): ToolActivityDescriptor {
	return ({
		image: { category, label: "Generating image" },
		thinking: { category, label: "Thinking" },
		shell: { category, label: "Running command" },
		file: { category, label: "Working with files" },
		search: { category, label: "Searching web" },
		browser: { category, label: "Using browser" },
		plan: { category, label: "Updating plan" },
		agent: { category, label: "Working with agent" },
		input: { category, label: "Waiting for answer" },
		terminal: { category, label: "Finishing turn" },
		other: { category, label: "Working" },
	})[category];
}

function programmaticExecActivity(value: unknown): ToolActivityDescriptor {
	if (computerUseDescriptorFromExec(value)) return { category: "browser", label: "Using browser" };
	const tools = programmaticToolNames(value).map(activityDescriptorForTool);
	if (tools.length === 0) return { category: "other", label: "Working" };
	const categories = new Set(tools.map((tool) => tool.category));
	if (categories.size > 1) return { category: "other", label: "Using multiple tools" };
	if (tools.length > 1) return activityDescriptorForCategory(tools[0]!.category);
	return tools[0]!;
}

interface AstNode extends Record<string, unknown> {
	type: string;
}

const UNSUPPORTED_AST_VALUE = Symbol("unsupported-ast-value");

function programmaticToolNames(value: unknown): string[] {
	const root = parseProgrammaticSource(value);
	if (!root) return [];
	const names: string[] = [];
	walkAst(root, (node) => {
		if (node.type !== "CallExpression") return;
		const callee = astNode(node.callee);
		if (!callee || callee.type !== "MemberExpression") return;
		const target = astNode(callee.object);
		if (!target || target.type !== "Identifier" || target.name !== "tools") return;
		const name = memberPropertyName(callee);
		if (name) names.push(name);
	});
	return names;
}

function parseProgrammaticSource(value: unknown): AstNode | undefined {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PROGRAMMATIC_SOURCE_BYTES) return undefined;
	try {
		return parse(value, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as AstNode;
	} catch {
		return undefined;
	}
}

/** Extract literal tools.update_plan(...) arguments without evaluating rollout code. */
function programmaticPlanInputs(value: unknown): unknown[] {
	const root = parseProgrammaticSource(value);
	if (!root) return [];
	const inputs: unknown[] = [];
	walkAst(root, (node) => {
		if (node.type !== "CallExpression") return;
		const callee = astNode(node.callee);
		if (!callee || callee.type !== "MemberExpression") return;
		const target = astNode(callee.object);
		if (!target || target.type !== "Identifier" || target.name !== "tools") return;
		if (memberPropertyName(callee) !== "update_plan") return;
		const args = Array.isArray(node.arguments) ? node.arguments : [];
		const input = staticAstValue(args[0]);
		if (input !== UNSUPPORTED_AST_VALUE && objectValue(input)) inputs.push(input);
	});
	return inputs;
}

function walkAst(value: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) walkAst(item, visit);
		return;
	}
	const node = astNode(value);
	if (!node) return;
	visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
		walkAst(child, visit);
	}
}

function astNode(value: unknown): AstNode | undefined {
	return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
		? value as AstNode
		: undefined;
}

function memberPropertyName(node: AstNode): string | undefined {
	const property = astNode(node.property);
	if (!property) return undefined;
	if (property.type === "Identifier" && node.computed !== true) return stringValue(property.name);
	if (property.type === "Literal") return typeof property.value === "string" ? property.value : undefined;
	return undefined;
}

function staticAstValue(value: unknown): unknown | typeof UNSUPPORTED_AST_VALUE {
	const node = astNode(value);
	if (!node) return UNSUPPORTED_AST_VALUE;
	if (node.type === "Literal") return node.value;
	if (node.type === "TemplateLiteral") {
		const expressions = Array.isArray(node.expressions) ? node.expressions : [];
		const quasis = Array.isArray(node.quasis) ? node.quasis : [];
		if (expressions.length > 0 || quasis.length !== 1) return UNSUPPORTED_AST_VALUE;
		const quasi = astNode(quasis[0]);
		const cooked = objectValue(quasi?.value)?.cooked;
		return typeof cooked === "string" ? cooked : UNSUPPORTED_AST_VALUE;
	}
	if (node.type === "ArrayExpression") {
		if (!Array.isArray(node.elements)) return UNSUPPORTED_AST_VALUE;
		const result: unknown[] = [];
		for (const element of node.elements) {
			const item = staticAstValue(element);
			if (item === UNSUPPORTED_AST_VALUE) return UNSUPPORTED_AST_VALUE;
			result.push(item);
		}
		return result;
	}
	if (node.type === "ObjectExpression") {
		if (!Array.isArray(node.properties)) return UNSUPPORTED_AST_VALUE;
		const result: Record<string, unknown> = {};
		for (const candidate of node.properties) {
			const property = astNode(candidate);
			if (!property || property.type !== "Property" || property.kind !== "init" || property.method === true || property.shorthand === true) return UNSUPPORTED_AST_VALUE;
			const key = propertyName(property);
			const propertyValue = staticAstValue(property.value);
			if (!key || propertyValue === UNSUPPORTED_AST_VALUE) return UNSUPPORTED_AST_VALUE;
			result[key] = propertyValue;
		}
		return result;
	}
	return UNSUPPORTED_AST_VALUE;
}

function propertyName(property: AstNode): string | undefined {
	const key = astNode(property.key);
	if (!key) return undefined;
	if (key.type === "Identifier" && property.computed !== true) return stringValue(key.name);
	if (key.type === "Literal") return typeof key.value === "string" ? key.value : undefined;
	return undefined;
}

function planItemsFromInput(value: unknown): Array<{ text: string; completed: boolean; active?: boolean }> {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try { parsed = JSON.parse(value); } catch { return []; }
	}
	const record = objectValue(parsed);
	const plan = Array.isArray(record?.plan) ? record.plan : Array.isArray(record?.todos) ? record.todos : [];
	return plan.flatMap((item) => {
		const row = objectValue(item);
		const text = stringValue(row?.step) ?? stringValue(row?.content) ?? stringValue(row?.text);
		if (!text) return [];
		const status = stringValue(row?.status)?.toLowerCase();
		return [{ text, completed: status === "completed" || status === "done", active: status === "in_progress" || status === "inprogress" || status === "active" }];
	});
}

function hasPlanInput(value: unknown): boolean {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try { parsed = JSON.parse(value); } catch { return false; }
	}
	const record = objectValue(parsed);
	return Array.isArray(record?.plan) || Array.isArray(record?.todos);
}

function readLatestUserText(filePath: string, size: number): string | undefined {
 let latest: string | undefined;
 const reader = new BoundedJsonlReader(line => { const title = meaningfulUserText([line]); if (title) latest = preferUserTitle(latest, title); });
 const handle = fs.openSync(filePath,"r");
 const buffer = Buffer.alloc(LIFECYCLE_SCAN_CHUNK_BYTES);
 try {
  for (let position = Math.max(0,size-MAX_TITLE_SCAN_BYTES); position < size;) {
   const n = fs.readSync(handle,buffer,0,Math.min(buffer.length,size-position),position);
   if (!n) break;
   reader.write(buffer.subarray(0,n)); position += n;
  }
 } finally { fs.closeSync(handle); }
 return latest;
}

function compactProgress(state: RolloutParseState): void {
 const latest = new Map<ProgressEvent["type"], ProgressEvent>();
 const start = state.progressEvents.find(event => event.type === "turn.started");
 for (let event of state.progressEvents) {
  if (event.type === "recap") { const text = safeProgressText(event.text,220); if (!text) continue; event = {...event,text}; }
  if (start && event.turnId !== start.turnId) continue;
  const previous = latest.get(event.type);
  if (!previous || event.at >= previous.at) {
   // Equal timestamps still follow transport order, including across polls.
   latest.delete(event.type); latest.set(event.type,event);
  }
 }
 state.progressEvents = [...latest.values()].sort((a,b)=>a.at-b.at);
}

function readRange(filePath: string, start: number, end: number): Buffer {
	const length = Math.max(0, end - start);
	if (length === 0) return Buffer.alloc(0);
	const handle = fs.openSync(filePath, "r");
	const buffer = Buffer.alloc(length);
	try { fs.readSync(handle, buffer, 0, length, start); } finally { fs.closeSync(handle); }
	return buffer;
}

function rolloutOverlap(filePath: string, end: number): string {
	const start = Math.max(0, end - ROLLOUT_OVERLAP_BYTES);
	return readRange(filePath, start, end).toString("base64");
}

/** Find the newest turn start, then replay that whole turn to restore process + recap state. */
function latestLifecycleBoundaryOffset(filePath: string, size: number): number {
 const handle = fs.openSync(filePath,"r");
 const buffer = Buffer.alloc(LIFECYCLE_SCAN_CHUNK_BYTES);
 let position = size;
 let prefix = Buffer.alloc(0);
 try {
  while (position > 0) {
   const start = Math.max(0,position-buffer.length);
   const n = fs.readSync(handle,buffer,0,position-start,start);
   let end = n;
   for (let index = n-1; index >= 0; index--) {
    if (buffer[index] !== 10) continue;
    const leading = buffer.subarray(index+1,end);
    const line = Buffer.concat([leading,prefix],Math.min(64*1024,leading.length+prefix.length));
    if (isLifecycleBoundary(line.toString("utf8"))) return start+index+1;
    prefix = Buffer.alloc(0); end = index;
   }
   const leading = buffer.subarray(0,end);
   prefix = Buffer.concat([leading,prefix],Math.min(64*1024,leading.length+prefix.length));
   position = start;
  }
  return 0;
 } finally { fs.closeSync(handle); }
}

function isLifecycleBoundary(rawLine: string): boolean {
	if (!rawLine.includes('"task_started"')) return false;
	try {
		const record = JSON.parse(rawLine.trim()) as RolloutRecord;
		if (record.type !== "event_msg") return false;
		return record.payload?.type === "task_started";
	} catch {
		return false;
	}
}

function userTextFromRecord(record: RolloutRecord): string | undefined {
 const payload = record.payload;
 if (record.type === "event_msg" && payload?.type === "user_message") return normalizeUserPrompt(payload.message);
 if (record.type === "response_item" && payload?.type === "message" && payload.role === "user") {
  return normalizeUserPrompt(payload.content?.find(item=>item.type === "input_text")?.text);
 }
 return undefined;
}

function preferUserTitle(previous: string | undefined, value: string): string {
 return (!previous || (value.length >= 12 && !/^(执行|继续|开始|好的|确认|可以|同意|按.+方案)/.test(value))) ? value.slice(0,1024) : previous;
}

function meaningfulUserText(lines: string[]): string | undefined {
 let latest: string | undefined;
 for (const line of lines) {
  try { const title = userTextFromRecord(JSON.parse(line)); if (title) latest = preferUserTitle(latest,title); }
  catch { /* Ignore partial or malformed records. */ }
 }
 return latest;
}

function normalizeUserPrompt(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const marker = "## My request for Codex:";
	const request = value.includes(marker) ? value.slice(value.lastIndexOf(marker) + marker.length) : value;
	const normalized = request
		.replace(/<image[\s\S]*?<\/image>/gi, " ")
		.replace(/^#+\s+.*$/gm, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized || undefined;
}
