import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeReasoningEffort, type ReasoningEffort, type Task, type TaskStatus } from "@streamdeck-supervisor/shared";
import { baseTask, projectLabelFromCwd, safeTaskTitle } from "./types.js";
import { activityCategoryForTool, reduceProgressEvents, type ProgressEvent } from "../progress-reducer.js";

type JsonRecord = Record<string, unknown>;

const INTERRUPT_MARKER = /^\[Request interrupted by user\b/;
const LOCAL_COMMAND_MARKER = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;

interface TranscriptState {
	sessionId: string;
	cwd: string;
	customTitle?: string;
	aiTitle?: string;
	slug?: string;
	firstUserText?: string;
	status: TaskStatus;
	lastEventAt: number;
	startedAt: number;
	isSidechain: boolean;
	reasoningEffort?: ReasoningEffort;
	model?: string;
	turnId: string;
	progressEvents: ProgressEvent[];
	toolById: Map<string, string>;
	todoKeyByToolId: Map<string, string>;
	pendingTodoUpdates: Map<string, { name: string; input?: JsonRecord }>;
	subagentToolIds: Set<string>;
	todos: Map<string, { text: string; status: string }>;
}

function stringField(record: JsonRecord, name: string): string | undefined {
	const value = record[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageText(record: JsonRecord): string | undefined {
	const message = record.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const content = (message as JsonRecord).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as JsonRecord).text === "string") return String((item as JsonRecord).text);
	}
	return undefined;
}

function applyRecord(state: TranscriptState, raw: JsonRecord, now: number, sequence: number): void {
	state.sessionId = stringField(raw, "sessionId") ?? state.sessionId;
	state.cwd = stringField(raw, "cwd") ?? state.cwd;
	state.slug = stringField(raw, "slug") ?? state.slug;
	state.reasoningEffort = normalizeReasoningEffort(raw.effort ?? raw.effortLevel) ?? state.reasoningEffort;
	state.isSidechain ||= raw.isSidechain === true;
	const type = stringField(raw, "type");
	const timestamp = stringField(raw, "timestamp");
	const eventAt = timestamp ? Date.parse(timestamp) || now : now;
	const eventId = (suffix: string) => `claude:${state.sessionId}:${sequence}:${suffix}`;
	if (type === "custom-title") state.customTitle = stringField(raw, "customTitle") ?? state.customTitle;
	if (type === "ai-title") state.aiTitle = stringField(raw, "aiTitle") ?? state.aiTitle;
	let lifecycleEvent = false;
	if (type === "user") {
		const message = raw.message && typeof raw.message === "object" ? raw.message as JsonRecord : {};
		const content = Array.isArray(message.content) ? message.content : [];
		const toolResults = content.filter((item) => objectRecord(item)?.type === "tool_result");
		const texts = typeof message.content === "string" ? [message.content.trim()]
			: content.flatMap((item) => {
				const block = objectRecord(item);
				return block?.type === "text" && typeof block.text === "string" ? [block.text.trim()] : [];
			});
		// Esc and local CLI commands (/model, ! bash) are written as user rows.
		// They are not prompts: an interrupt ends the turn, a command starts none.
		const interrupted = texts.some((text) => INTERRUPT_MARKER.test(text));
		const hasPromptContent = !interrupted && (content.some((item) => {
			const type = objectRecord(item)?.type;
			return type === "image" || type === "document";
		}) || texts.some((text) => !!text && !LOCAL_COMMAND_MARKER.test(text)));
		let todosChanged = false;
		for (const item of toolResults) {
			const row = objectRecord(item)!;
			const toolId = stringField(row, "tool_use_id");
			if (!toolId) continue;
			const toolName = state.toolById.get(toolId) ?? "Tool";
			if (toolName === "TaskCreate") todosChanged = resolveCreatedTodo(state, toolId, row, raw.toolUseResult) || todosChanged;
			const pendingTodo = state.pendingTodoUpdates.get(toolId);
			if (pendingTodo && row.is_error !== true) todosChanged = updateClaudeTodos(state, pendingTodo.name, pendingTodo.input, toolId) || todosChanged;
			state.pendingTodoUpdates.delete(toolId);
			state.progressEvents.push({
				id: eventId(`tool-result:${toolId}`), at: eventAt, turnId: state.turnId, type: "activity",
				category: activityCategoryForTool(toolName), label: displayToolName(toolName),
				state: row.is_error === true ? "error" : "done",
			});
			if (state.subagentToolIds.has(toolId)) state.progressEvents.push({
				id: eventId(`agent-result:${toolId}`), at: eventAt, turnId: state.turnId, type: "subagent", childId: toolId,
				state: row.is_error === true ? "error" : "completed",
			});
		}
		if (todosChanged) state.progressEvents.push({ id: eventId("todos"), at: eventAt, turnId: state.turnId, type: "todo", items: claudeTodoItems(state) });
		if (interrupted) {
			if (state.status === "RUNNING") {
				state.status = "PAUSED";
				state.progressEvents.push({ id: eventId("terminal"), at: eventAt, turnId: state.turnId, type: "turn.terminal", terminal: "interrupted" });
				lifecycleEvent = true;
			}
		} else if (toolResults.length > 0) {
			state.status = "RUNNING";
			lifecycleEvent = true;
		} else if (raw.isMeta !== true && raw.isCompactSummary !== true && hasPromptContent) {
			state.firstUserText ??= messageText(raw);
			state.turnId = `${state.sessionId}:${eventAt}`;
			state.progressEvents = [{ id: eventId("turn-start"), at: eventAt, turnId: state.turnId, type: "turn.started" }];
			state.toolById.clear();
			state.todoKeyByToolId.clear();
			state.pendingTodoUpdates.clear();
			state.subagentToolIds.clear();
			state.todos.clear();
			// A new prompt can select another model/effort. Previous-turn metadata
			// is not evidence of what this turn is actually executing.
			state.model = undefined;
			state.reasoningEffort = normalizeReasoningEffort(raw.effort ?? raw.effortLevel);
			state.status = "RUNNING";
			lifecycleEvent = true;
		}
	}
	if (type === "assistant") {
		const message = raw.message && typeof raw.message === "object" ? raw.message as JsonRecord : {};
		const stopReason = stringField(message, "stop_reason");
		const model = stringField(message, "model");
		if (model && model !== "<synthetic>") state.model = model;
		const isError = raw.isApiErrorMessage === true || typeof raw.error === "string";
		const content = Array.isArray(message.content) ? message.content : [];
		let todosChanged = false;
		for (const item of content) {
			const row = objectRecord(item);
			if (!row) continue;
			if (row.type === "text" && typeof row.text === "string" && row.text.trim()) {
				state.progressEvents.push({ id: eventId("recap"), at: eventAt, turnId: state.turnId, type: "recap", text: row.text });
			}
			if (row.type !== "tool_use") continue;
			const toolId = stringField(row, "id") ?? `${sequence}`;
			const toolName = stringField(row, "name") ?? "Tool";
			const input = objectRecord(row.input);
			state.toolById.set(toolId, toolName);
			state.progressEvents.push({
				id: eventId(`tool:${toolId}`), at: eventAt, turnId: state.turnId, type: "activity",
				category: activityCategoryForTool(toolName), label: fileActivityLabel(toolName, input), state: "running",
			});
			if (/^(Agent|Task)$/i.test(toolName)) {
				state.subagentToolIds.add(toolId);
				state.progressEvents.push({ id: eventId(`agent:${toolId}`), at: eventAt, turnId: state.turnId, type: "subagent", childId: toolId, state: "started" });
			}
			if (toolName === "TaskCreate") todosChanged = updateClaudeTodos(state, toolName, input, toolId) || todosChanged;
			else if (/TaskUpdate|Todo|Plan/i.test(toolName)) state.pendingTodoUpdates.set(toolId, { name: toolName, input });
			if (/question|input/i.test(toolName)) state.progressEvents.push({ id: eventId(`input:${toolId}`), at: eventAt, turnId: state.turnId, type: "input", label: "Waiting for answer" });
		}
		if (todosChanged || state.todos.size > 0) state.progressEvents.push({ id: eventId("todos"), at: eventAt, turnId: state.turnId, type: "todo", items: claudeTodoItems(state) });
		// Streaming records can have a null/missing stop_reason. A partial
		// assistant message does not end the turn or stop the running clock.
		const terminal = isError || (!!stopReason && stopReason !== "tool_use" && stopReason !== "pause_turn");
		state.status = isError ? "ERROR" : terminal ? "DONE_UNREAD" : "RUNNING";
		if (terminal) state.progressEvents.push({
			id: eventId("terminal"), at: eventAt, turnId: state.turnId, type: "turn.terminal", terminal: isError ? "error" : "completed",
		});
		lifecycleEvent = true;
	}
	// Claude appends metadata such as mode/title/last-prompt when a conversation is opened.
	// Those records must not turn an already acknowledged result into a new attention event.
	if (lifecycleEvent) {
		state.lastEventAt = Math.max(state.lastEventAt, eventAt);
		state.startedAt ||= eventAt;
	}
}

function taskFromState(state: TranscriptState, now: number): Task | null {
	if (state.isSidechain || !state.sessionId || !state.cwd) return null;
	const title = state.customTitle ?? state.aiTitle ?? state.slug?.replace(/[-_]+/g, " ") ?? state.firstUserText ?? "Claude session";
	const task = baseTask("claude", {
		taskId: `claude:${state.sessionId}`,
		externalId: state.sessionId,
		projectId: state.cwd,
		projectLabel: projectLabelFromCwd(state.cwd, "CLAUDE"),
		cwd: state.cwd,
		titleShort: safeTaskTitle(title, "Claude session"),
		reasoningEffort: state.reasoningEffort,
		model: state.model,
		status: state.status,
		lastEventAt: state.lastEventAt,
		startedAt: state.startedAt || state.lastEventAt,
		source: "transcript-tail",
		openRef: { kind: "url", value: `claude://resume?session=${encodeURIComponent(state.sessionId)}` },
	}, { approve: false, reject: false, interrupt: false, review: true, verify: true });
	task.progress = reduceProgressEvents(state.progressEvents, now).progress;
	task.lastExecutionActivityAt = state.progressEvents.reduce((latest, event) => Math.max(latest, event.at), state.lastEventAt);
	return task;
}

export function parseClaudeTranscript(records: unknown[], filePath: string, now = Date.now()): Task | null {
	if (filePath.split(path.sep).includes("subagents")) return null;
	const state: TranscriptState = {
		sessionId: path.basename(filePath, ".jsonl"), cwd: "", status: "DONE_UNREAD",
		lastEventAt: 0, startedAt: 0, isSidechain: false, turnId: "current",
		progressEvents: [], toolById: new Map(), todoKeyByToolId: new Map(), pendingTodoUpdates: new Map(), subagentToolIds: new Set(), todos: new Map(),
	};
	let sequence = 0;
	for (const value of records) {
		sequence += 1;
		if (value && typeof value === "object" && !Array.isArray(value)) applyRecord(state, value as JsonRecord, now, sequence);
	}
	if (!state.lastEventAt) return null;
	state.startedAt ||= state.lastEventAt;
	return taskFromState(state, now);
}

function objectRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function displayToolName(value: string): string {
	return value.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().slice(0, 40) || "Tool";
}

function updateClaudeTodos(state: TranscriptState, toolName: string, input: JsonRecord | undefined, fallbackId: string): boolean {
	if (!input) return false;
	if (/TaskCreate/i.test(toolName)) {
		const id = stringField(input, "taskId") ?? stringField(input, "id") ?? fallbackId;
		const text = stringField(input, "subject") ?? stringField(input, "description") ?? "Task";
		state.todos.set(id, { text, status: "pending" });
		state.todoKeyByToolId.set(fallbackId, id);
		return true;
	}
	if (/TaskUpdate/i.test(toolName)) {
		const id = stringField(input, "taskId") ?? stringField(input, "id");
		if (!id) return false;
		if (input.status === "deleted") return state.todos.delete(id);
		const existing = state.todos.get(id) ?? { text: stringField(input, "subject") ?? "Task", status: "pending" };
		state.todos.set(id, { text: stringField(input, "subject") ?? existing.text, status: stringField(input, "status") ?? existing.status });
		return true;
	}
	if (!/Todo|Plan/i.test(toolName)) return false;
	const rawTodos = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : undefined;
	if (!rawTodos) return false;
	state.todos.clear();
	for (const [index, item] of rawTodos.entries()) {
		const row = objectRecord(item);
		const text = row && (stringField(row, "content") ?? stringField(row, "text") ?? stringField(row, "step"));
		if (text) state.todos.set(String(index), { text, status: stringField(row!, "status") ?? "pending" });
	}
	return true;
}

function resolveCreatedTodo(state: TranscriptState, toolId: string, result: JsonRecord, rawResult: unknown): boolean {
	const provisionalId = state.todoKeyByToolId.get(toolId);
	if (!provisionalId) return false;
	if (result.is_error === true) return state.todos.delete(provisionalId);
	const structured = objectRecord(rawResult);
	const created = objectRecord(structured?.task) ?? structured;
	const text = typeof result.content === "string" ? result.content
		: Array.isArray(result.content) ? result.content.map((item) => objectRecord(item)?.text ?? "").join("\n") : "";
	const id = stringField(created ?? {}, "id") ?? stringField(created ?? {}, "taskId")
		?? /\bTask\s+#(\d+)\s+created\b/i.exec(text)?.[1];
	const todo = state.todos.get(provisionalId);
	if (!id || !todo || id === provisionalId) return false;
	state.todos.delete(provisionalId);
	state.todos.set(id, { ...todo, ...(state.todos.get(id) ?? {}) });
	state.todoKeyByToolId.set(toolId, id);
	return true;
}

function claudeTodoItems(state: TranscriptState): Array<{ text: string; completed: boolean; active?: boolean }> {
	return [...state.todos.values()].map((todo) => ({
		text: todo.text,
		completed: /completed|done/i.test(todo.status),
		active: /in_progress|active/i.test(todo.status),
	}));
}

export class ClaudeTranscriptWatcher {
	private readonly root: string;
	private readonly sessionRoot: string;
	private readonly mtimes = new Map<string, number>();
	private readonly tasksByFile = new Map<string, Task>();
	private readonly publishedSettings = new Map<string, string>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		root: string | undefined,
		private readonly onTask: (task: Task) => void,
		private readonly onError: (error: Error) => void,
		sessionRoot?: string,
	) {
		this.root = root ?? path.join(os.homedir(), ".claude", "projects");
		this.sessionRoot = sessionRoot ?? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
	}

	async start(): Promise<void> {
		await this.poll();
		this.timer = setInterval(() => void this.poll(), 2_000);
	}

	stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

	private async poll(): Promise<void> {
		try {
			const files = (await findTranscripts(this.root)).slice(-64);
			const desktopSessions = await readClaudeDesktopSessions(this.sessionRoot);
			const visibleFiles = new Set(files);
			for (const file of [...this.tasksByFile.keys()]) {
				if (!visibleFiles.has(file)) this.tasksByFile.delete(file);
			}
			for (const file of files) {
				const stat = await fs.promises.stat(file);
				const transcriptChanged = this.mtimes.get(file) !== stat.mtimeMs;
				if (transcriptChanged || !this.tasksByFile.has(file)) {
					const records: unknown[] = [];
					for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
						if (!line.trim()) continue;
						try { records.push(JSON.parse(line)); } catch { /* partial last line */ }
					}
					const parsed = parseClaudeTranscript(records, file, stat.mtimeMs);
					if (parsed) this.tasksByFile.set(file, parsed);
					else this.tasksByFile.delete(file);
					this.mtimes.set(file, stat.mtimeMs);
				}
				const task = this.tasksByFile.get(file);
				if (!task) continue;
				const session = desktopSessions.get(task.externalId);
				const effort = session ? session.effort : task.reasoningEffort;
				const model = task.model ?? session?.model;
				const settings = JSON.stringify([model, effort]);
				if (!transcriptChanged && this.publishedSettings.get(task.taskId) === settings && task.status !== "RUNNING") continue;
				const now = Date.now();
				const observed = {
					...task, model, reasoningEffort: effort, lastObservedAt: now,
					progress: task.status === "RUNNING" && task.progress.turnStartedAt
						? { ...task.progress, durationMs: Math.max(0, now - task.progress.turnStartedAt) } : task.progress,
				};
				this.onTask(observed);
				this.publishedSettings.set(task.taskId, settings);
			}
		} catch (error) { this.onError(error instanceof Error ? error : new Error(String(error))); }
	}
}

export interface ClaudeDesktopSessionSettings {
	effort?: ReasoningEffort;
	model?: string;
}

export async function readClaudeDesktopSessions(root: string): Promise<Map<string, ClaudeDesktopSessionSettings>> {
	const candidates = new Map<string, ClaudeDesktopSessionSettings & { score: number }>();
	for (const file of await findFiles(root, 3, (name) => /^local_.+\.json$/.test(name))) {
		try {
			const stat = await fs.promises.stat(file);
			const record = JSON.parse(await fs.promises.readFile(file, "utf8")) as JsonRecord;
			const sessionId = stringField(record, "cliSessionId");
			if (!sessionId) continue;
			const score = numberValue(record.lastActivityAt) ?? numberValue(record.lastFocusedAt) ?? stat.mtimeMs;
			const existing = candidates.get(sessionId);
			if (!existing || score >= existing.score) candidates.set(sessionId, {
				effort: normalizeReasoningEffort(record.effort), model: stringField(record, "model"), score,
			});
		} catch { /* Ignore partial or obsolete Desktop session records. */ }
	}
	return new Map([...candidates].map(([sessionId, { score: _, ...settings }]) => [sessionId, settings]));
}

export async function readClaudeDesktopSessionEfforts(root: string): Promise<Map<string, ReasoningEffort | undefined>> {
	return new Map([...await readClaudeDesktopSessions(root)].map(([id, settings]) => [id, settings.effort]));
}

export function readClaudeDefaultReasoningEffort(settingsPath = path.join(os.homedir(), ".claude", "settings.json")): ReasoningEffort | undefined {
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as JsonRecord;
		return normalizeReasoningEffort(settings.effortLevel);
	} catch {
		return undefined;
	}
}

async function findTranscripts(root: string): Promise<string[]> {
	const candidates: string[] = [];
	for (const project of await safeDirectories(root)) {
		const directory = path.join(root, project);
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(path.join(directory, entry.name));
		}
	}
	const withStats = await Promise.all(candidates.map(async (file) => ({ file, mtime: (await fs.promises.stat(file)).mtimeMs })));
	return withStats.sort((a, b) => a.mtime - b.mtime).map(({ file }) => file);
}

async function safeDirectories(directory: string): Promise<string[]> {
	try {
		const entries = await fs.promises.readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch { return []; }
}

async function findFiles(root: string, maxDepth: number, accepts: (name: string) => boolean): Promise<string[]> {
	const files: string[] = [];
	const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	while (queue.length > 0 && files.length < 1_024) {
		const current = queue.shift()!;
		let entries: fs.Dirent[];
		try { entries = await fs.promises.readdir(current.directory, { withFileTypes: true }); }
		catch { continue; }
		for (const entry of entries) {
			const candidate = path.join(current.directory, entry.name);
			if (entry.isFile() && accepts(entry.name)) files.push(candidate);
			else if (entry.isDirectory() && current.depth < maxDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
		}
	}
	return files;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fileActivityLabel(name: string, input: Record<string, unknown> | undefined): string {
 const file = input?.file_path ?? input?.path;
 if (/read|write|edit/i.test(name) && typeof file === "string") return `${/read/i.test(name) ? "Reading" : "Editing"} ${file.split(/[\\/]/).pop()}`;
 if (/imagegen|image_gen|generate_image/i.test(name)) return "Generating image";
 return displayToolName(name);
}
