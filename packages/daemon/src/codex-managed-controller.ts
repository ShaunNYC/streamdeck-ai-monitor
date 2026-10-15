import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	emptyTaskProgress,
	normalizeReasoningEffort,
	taskCapabilities,
	type AppServerStatus,
	type CodexModelDescriptor,
	type CreateManagedTaskRequest,
	type ManagedDesktopRequest,
	type ManagedQueueMessage,
	type ManagedTaskDetail,
	type PendingPlanInput,
	type PlanQuestion,
	type ReasoningEffort,
	type Task,
} from "@streamdeck-supervisor/shared";
import { activityCategoryForTool, reduceProgressEvents, safeProgressText, type ProgressEvent } from "./progress-reducer.js";
import { projectLabelFromCwd } from "./adapters/types.js";
import type { TaskRegistry } from "./task-registry.js";

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

interface StoredManagedSession {
	threadId: string;
	cwd: string;
	createdAt: number;
	model?: string;
	effort?: ReasoningEffort;
	activeTurnId?: string;
	queue: ManagedQueueMessage[];
	progressEvents?: ProgressEvent[];
}

interface StoredManagedState {
	version: 1 | 2;
	sessions: StoredManagedSession[];
}

interface PendingRpc {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface PendingServerRequest {
	rpcId: RpcId;
	method: string;
	detail: ManagedDesktopRequest;
}

export interface CodexManagedControllerOptions {
	registry: TaskRegistry;
	filePath: string;
	onPlanInput: (input: PendingPlanInput) => void;
	onPlanInputCleared: (requestId: string) => void;
	onStatus: (status: AppServerStatus) => void;
	codexBinary?: string;
}

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_QUEUE_MESSAGES = 20;
const MAX_QUEUE_BYTES = 64 * 1024;
const MAX_PROGRESS_EVENTS = 2_000;
const MANAGED_SERVER_REQUESTS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/tool/requestUserInput",
]);

/** Independent, lazily-started Codex app-server used only for NEO-owned tasks. */
export class CodexManagedController {
	private readonly sessions = new Map<string, StoredManagedSession>();
	private readonly pendingRpc = new Map<RpcId, PendingRpc>();
	private readonly serverRequests = new Map<string, PendingServerRequest>();
	private readonly progressEvents = new Map<string, ProgressEvent[]>();
	private readonly itemNames = new Map<string, string>();
	private readonly turnStartGenerations = new Map<string, number>();
	private process: ChildProcessWithoutNullStreams | undefined;
	private stdoutBuffer = "";
	private nextRpcId = 0;
	private startPromise: Promise<void> | undefined;
	private restoring = false;
	private status: AppServerStatus = { status: "OFFLINE", lastPollAt: 0 };

	constructor(private readonly options: CodexManagedControllerOptions) {
		this.load();
	}

	hasRegisteredSessions(): boolean { return this.sessions.size > 0; }
	isManagedThread(threadId: string): boolean { return this.sessions.has(threadId); }
	getStatus(): AppServerStatus { return { ...this.status }; }

	async restoreIfNeeded(): Promise<void> {
		if (this.sessions.size === 0) return;
		try { await this.ensureProcess(); }
		catch (error) {
			const message = `Codex app-server restore unavailable: ${errorMessage(error)}`;
			this.setStatus("DEGRADED", message);
			for (const session of this.sessions.values()) this.publish(session, { status: "ERROR", recap: message });
		}
	}

	async stop(): Promise<void> {
		const child = this.process;
		this.process = undefined;
		this.startPromise = undefined;
		for (const pending of this.pendingRpc.values()) pending.reject(new Error("Codex app-server stopped"));
		this.pendingRpc.clear();
		if (child && !child.killed) child.kill("SIGTERM");
		this.setStatus("OFFLINE");
	}

	async listModels(): Promise<CodexModelDescriptor[]> {
		await this.ensureProcess();
		const result = objectValue(await this.request("model/list", { limit: 100, includeHidden: false }));
		const rows = Array.isArray(result?.data) ? result.data : [];
		return rows.flatMap((value) => {
			const model = objectValue(value);
			const id = stringValue(model?.model) ?? stringValue(model?.id);
			if (!id) return [];
			const efforts = Array.isArray(model?.supportedReasoningEfforts)
				? model.supportedReasoningEfforts.flatMap((entry) => {
					const row = objectValue(entry);
					const effort = normalizeReasoningEffort(row?.reasoningEffort ?? row?.effort);
					return effort ? [effort] : [];
				})
				: [];
			return [{
				id,
				label: stringValue(model?.displayName) ?? id,
				...(stringValue(model?.description) ? { description: safeProgressText(stringValue(model?.description)!, 180) } : {}),
				...(normalizeReasoningEffort(model?.defaultReasoningEffort) ? { defaultEffort: normalizeReasoningEffort(model?.defaultReasoningEffort) } : {}),
				supportedEfforts: efforts,
				isDefault: model?.isDefault === true,
			}];
		});
	}

	async createTask(input: CreateManagedTaskRequest): Promise<ManagedTaskDetail> {
		validatePrompt(input.prompt);
		if (!path.isAbsolute(input.cwd)) throw new Error("Project directory must be an absolute path");
		const stat = fs.statSync(input.cwd);
		if (!stat.isDirectory()) throw new Error("Project directory does not exist");
		await this.ensureProcess();
		const response = objectValue(await this.request("thread/start", {
			cwd: input.cwd,
			...(input.model ? { model: input.model } : {}),
		}));
		const thread = objectValue(response?.thread);
		const threadId = stringValue(thread?.id);
		if (!threadId) throw new Error("Codex app-server did not return a thread id");
		const session: StoredManagedSession = {
			threadId,
			cwd: input.cwd,
			createdAt: numberValue(thread?.createdAt) ? numberValue(thread?.createdAt)! * 1_000 : Date.now(),
			model: stringValue(response?.model) ?? input.model,
			effort: normalizeReasoningEffort(response?.reasoningEffort) ?? input.effort,
			queue: [],
		};
		this.sessions.set(threadId, session);
		this.persist();
		this.publish(session, { status: "QUEUED" });
		try {
			await this.startTurn(session, input.prompt);
		} catch (error) {
			this.publish(session, { status: "ERROR", recap: errorMessage(error) });
			throw error;
		}
		return this.detailForThread(threadId)!;
	}

	async sendMessage(taskId: string, text: string): Promise<ManagedTaskDetail> {
		validatePrompt(text);
		const session = this.requireSession(taskId);
		this.assertQueueCapacity(session, text);
		session.queue.push({ id: queueId(), text, createdAt: Date.now(), state: "queued" });
		this.persist();
		this.publish(session);
		if (!session.activeTurnId) await this.drainQueue(session);
		return this.detailForThread(session.threadId)!;
	}

	async retryMessage(taskId: string, messageId: string): Promise<ManagedTaskDetail> {
		const session = this.requireSession(taskId);
		const message = session.queue.find((candidate) => candidate.id === messageId && candidate.state === "failed");
		if (!message) throw new Error("Failed queue message no longer exists");
		message.state = "queued";
		delete message.error;
		this.persist();
		this.publish(session);
		if (!session.activeTurnId) await this.drainQueue(session);
		return this.detailForThread(session.threadId)!;
	}

	async steer(taskId: string, text: string): Promise<void> {
		validatePrompt(text);
		const session = this.requireSession(taskId);
		if (!session.activeTurnId) throw new Error("There is no active turn to steer");
		await this.ensureProcess();
		await this.request("turn/steer", { threadId: session.threadId, expectedTurnId: session.activeTurnId, input: [textInput(text)] });
	}

	async updateSettings(taskId: string, settings: { model?: string; effort?: ReasoningEffort }): Promise<void> {
		const session = this.requireSession(taskId);
		const task = this.options.registry.getTask(taskId);
		if (task?.ownership !== "managed" || !task.capabilities.desktop.changeSettings) throw new Error("Task does not allow settings changes");
		if (!settings.model && !settings.effort) throw new Error("No settings were supplied");
		await this.ensureProcess();
		await this.request("thread/settings/update", {
			threadId: session.threadId,
			...(settings.model ? { model: settings.model } : {}),
			...(settings.effort ? { effort: settings.effort } : {}),
		});
		if (settings.model) session.model = settings.model;
		if (settings.effort) session.effort = settings.effort;
		this.persist();
		this.publish(session);
	}

	async interrupt(taskId: string): Promise<void> {
		const session = this.requireSession(taskId);
		const task = this.options.registry.getTask(taskId);
		const turnId = session.activeTurnId;
		if (!turnId || task?.ownership !== "managed" || task.executionId !== turnId || !task.capabilities.desktop.interrupt) throw new Error("Turn is no longer interruptible");
		await this.ensureProcess();
		await this.request("turn/interrupt", { threadId: session.threadId, turnId });
	}

	async resolveRequest(taskId: string, requestId: string, response: { decision?: "accept" | "decline"; answers?: Record<string, string[]> }): Promise<void> {
		const session = this.requireSession(taskId);
		const pending = this.serverRequests.get(requestId);
		const task = this.options.registry.getTask(taskId);
		if (!pending || task?.ownership !== "managed" || pending.detail.threadId !== session.threadId
			|| pending.detail.turnId !== session.activeTurnId || task.executionId !== pending.detail.turnId) throw new Error("Request is stale or belongs to another turn");
		if (pending.detail.kind === "question") {
			if (!response.answers) throw new Error("Question answers are required");
			const allowedIds = new Set(pending.detail.questions?.map((question) => question.id));
			if (Object.keys(response.answers).some((id) => !allowedIds.has(id))) throw new Error("Question identity mismatch");
			this.respond(pending.rpcId, { answers: Object.fromEntries(Object.entries(response.answers).map(([id, answers]) => [id, { answers }])) });
		} else {
			if (response.decision !== "accept" && response.decision !== "decline") throw new Error("Approval decision is required");
			this.respond(pending.rpcId, { decision: response.decision });
		}
		this.clearServerRequest(requestId);
	}

	async answerPlanChoice(taskId: string, requestId: string, questionId: string, optionIndex: number): Promise<void> {
		const pending = this.serverRequests.get(requestId);
		const question = pending?.detail.questions?.find((candidate) => candidate.id === questionId);
		const option = question?.options[optionIndex];
		if (!pending || pending.detail.kind !== "question" || pending.detail.questions?.length !== 1 || !question || !option) throw new Error("Plan choice is stale");
		await this.resolveRequest(taskId, requestId, { answers: { [questionId]: [option.label] } });
	}

	getDetails(): ManagedTaskDetail[] {
		return [...this.sessions.keys()].flatMap((threadId) => {
			const detail = this.detailForThread(threadId);
			return detail ? [detail] : [];
		});
	}

	getDetail(taskId: string): ManagedTaskDetail | undefined {
		const session = this.sessionFromTaskId(taskId);
		return session ? this.detailForThread(session.threadId) : undefined;
	}

	private async ensureProcess(): Promise<void> {
		if (this.process && !this.process.killed) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.launch();
		try { await this.startPromise; }
		finally { this.startPromise = undefined; }
	}

	private async launch(): Promise<void> {
		this.setStatus("CONNECTING");
		const binary = this.options.codexBinary ?? findCodexBinary();
		const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
		this.process = child;
		this.stdoutBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
		child.once("error", (error) => this.handleExit(child, error));
		child.once("exit", (code, signal) => this.handleExit(child, new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${safeProgressText(stderr, 300)}` : ""}`)));
		await this.request("initialize", {
			clientInfo: { name: "neo-ai-control-supervisor", version: "3.3.0-beta.7" },
			// thread/settings/update is currently gated as an experimental method;
			// transport remains the documented stdio JSONL lifecycle.
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		this.notify("initialized", {});
		this.setStatus("OK");
		await this.restoreSessions();
	}

	private async restoreSessions(): Promise<void> {
		if (this.restoring) return;
		this.restoring = true;
		try {
			for (const session of this.sessions.values()) {
				try {
					const result = objectValue(await this.request("thread/read", { threadId: session.threadId, includeTurns: true }));
					this.restoreThread(session, objectValue(result?.thread));
				} catch (error) {
					this.publish(session, { status: "ERROR", recap: `Restore failed: ${errorMessage(error)}` });
				}
			}
		} finally { this.restoring = false; }
	}

	private restoreThread(session: StoredManagedSession, thread: JsonObject | undefined): void {
		if (!thread || stringValue(thread.id) !== session.threadId) throw new Error("Restored thread identity mismatch");
		const turns = Array.isArray(thread.turns) ? thread.turns.map(objectValue).filter((value): value is JsonObject => !!value) : [];
		const turn = turns.at(-1);
		let events: ProgressEvent[] = [];
		if (turn) {
			const turnId = stringValue(turn.id) ?? "restored";
			const startedAt = secondsToMs(turn.startedAt) ?? session.createdAt;
			const persisted = this.progressEvents.get(session.threadId) ?? [];
			if (persisted.some((event) => event.type === "turn.started" && event.turnId === turnId)) {
				events = persisted.filter((event) => event.turnId === turnId);
			} else {
				events.push({ id: `restore:${turnId}:start`, at: startedAt, turnId, type: "turn.started" });
			}
			const status = stringValue(turn.status)?.toLowerCase();
			const active = status === "inprogress" || status === "in_progress" || status === "running";
			if (active) events = events.filter((event) => event.type !== "turn.terminal");
			const items = Array.isArray(turn.items) ? turn.items : [];
			const restoredAt = Date.now();
			for (const [index, item] of items.entries()) this.eventsFromRestoredItem(events, turnId, objectValue(item), index, restoredAt);
			const completedAt = secondsToMs(turn.completedAt);
			if (completedAt || status === "completed" || status === "failed" || status === "interrupted") events.push({
				id: `restore:${turnId}:terminal`, at: completedAt ?? Date.now(), turnId, type: "turn.terminal",
				terminal: status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "completed",
			});
			session.activeTurnId = active ? turnId : undefined;
		}
		this.setProgressEvents(session, events);
		this.persist();
		this.publish(session);
		if (!session.activeTurnId) void this.drainQueue(session);
	}

	private eventsFromRestoredItem(events: ProgressEvent[], turnId: string, item: JsonObject | undefined, index: number, at: number): void {
		if (!item) return;
		const type = stringValue(item.type) ?? "other";
		const id = stringValue(item.id) ?? String(index);
		if (type === "agentMessage" && stringValue(item.text)) events.push({ id: `restore:${turnId}:${id}:recap`, at: at + index + 1, turnId, type: "recap", text: item.text as string });
		if (isSubagentItemType(type)) for (const child of subagentStatesForItem(item, "restored")) events.push({
			id: `restore:${turnId}:${id}:${child.childId}:${child.state}`,
			at: at + index + 1,
			turnId,
			type: "subagent",
			childId: child.childId,
			state: child.state,
		});
	}

	private async startTurn(session: StoredManagedSession, text: string): Promise<void> {
		await this.ensureProcess();
		const generation = (this.turnStartGenerations.get(session.threadId) ?? 0) + 1;
		this.turnStartGenerations.set(session.threadId, generation);
		const response = objectValue(await this.request("turn/start", {
			threadId: session.threadId,
			input: [textInput(text)],
			...(session.model ? { model: session.model } : {}),
			...(session.effort ? { effort: session.effort } : {}),
		}));
		const turn = objectValue(response?.turn);
		const turnId = stringValue(turn?.id);
		if (!turnId) throw new Error("Codex app-server did not return a turn id");
		// App-server notifications can be delivered in the same stdout chunk as
		// the RPC response. Their state is authoritative, and a delayed response
		// from an older overlapping start must never replace a newer Turn.
		if (this.turnStartGenerations.get(session.threadId) !== generation) return;
		const startedAt = secondsToMs(turn?.startedAt) ?? Date.now();
		if (!this.reconcileTurnStarted(session, turnId, startedAt, `managed:${turnId}:start`)) return;
		this.persist();
		this.publish(session);
	}

	private reconcileTurnStarted(session: StoredManagedSession, turnId: string, startedAt: number, eventId: string): boolean {
		const existing = this.progressEvents.get(session.threadId) ?? [];
		const latestStart = existing.reduce<Extract<ProgressEvent, { type: "turn.started" }> | undefined>((latest, event) => {
			if (event.type !== "turn.started") return latest;
			return !latest || event.at >= latest.at ? event : latest;
		}, undefined);
		if (latestStart && latestStart.turnId !== turnId && latestStart.at > startedAt) return false;

		const currentTurnEvents = existing.filter((event) => event.turnId === turnId);
		if (!currentTurnEvents.some((event) => event.type === "turn.started")) {
			currentTurnEvents.push({ id: eventId, at: startedAt, turnId, type: "turn.started" });
		}
		this.setProgressEvents(session, currentTurnEvents);
		const events = this.progressEvents.get(session.threadId) ?? [];
		const reduction = reduceProgressEvents(events, Date.now());
		session.activeTurnId = reduction.terminal ? undefined : turnId;
		return true;
	}

	private async drainQueue(session: StoredManagedSession): Promise<void> {
		if (session.activeTurnId) return;
		const message = session.queue.find((candidate) => candidate.state === "queued");
		if (!message) return;
		message.state = "sending";
		this.persist();
		this.publish(session);
		try {
			await this.startTurn(session, message.text);
			session.queue = session.queue.filter((candidate) => candidate.id !== message.id);
			this.persist();
			this.publish(session);
		} catch (error) {
			message.state = "failed";
			message.error = errorMessage(error);
			this.persist();
			this.publish(session, { status: "ERROR", recap: message.error });
		}
	}

	private consumeStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			try { this.handleMessage(JSON.parse(line) as JsonObject); }
			catch { /* Ignore malformed stdout without leaking it. */ }
		}
	}

	private handleMessage(message: JsonObject): void {
		const method = stringValue(message.method);
		if (method && message.id !== undefined) {
			if (MANAGED_SERVER_REQUESTS.has(method)) this.handleServerRequest(message.id as RpcId, method, objectValue(message.params));
			else this.respondError(message.id as RpcId, -32601, `Unsupported app-server request: ${safeProgressText(method, 80)}`);
			return;
		}
		if (method) {
			this.handleNotification(method, objectValue(message.params));
			return;
		}
		const id = message.id as RpcId | undefined;
		if (id === undefined) return;
		const pending = this.pendingRpc.get(id);
		if (!pending) return;
		this.pendingRpc.delete(id);
		if (message.error) pending.reject(new Error(rpcError(message.error)));
		else pending.resolve(message.result);
	}

	private handleNotification(method: string, params: JsonObject | undefined): void {
		const threadId = stringValue(params?.threadId);
		if (!threadId) return;
		const session = this.sessions.get(threadId);
		if (!session) return;
		const turn = objectValue(params?.turn);
		const turnId = stringValue(params?.turnId) ?? stringValue(turn?.id) ?? session.activeTurnId ?? "current";
		const events = this.progressEvents.get(threadId) ?? [];
		const now = numberValue(params?.startedAtMs) ?? numberValue(params?.completedAtMs) ?? Date.now();
		if (method === "turn/started") {
			if (!this.reconcileTurnStarted(session, turnId, secondsToMs(turn?.startedAt) ?? now, `notify:${turnId}:start`)) return;
			this.persist();
			this.publish(session);
			return;
		}
		if (method === "turn/completed") {
			const status = stringValue(turn?.status)?.toLowerCase() ?? "completed";
			events.push({ id: `notify:${turnId}:terminal`, at: secondsToMs(turn?.completedAt) ?? now, turnId, type: "turn.terminal", terminal: status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "completed" });
			if (session.activeTurnId === turnId) session.activeTurnId = undefined;
		}
		if (method === "turn/plan/updated") {
			const plan = Array.isArray(params?.plan) ? params.plan : [];
			events.push({
				id: `notify:${turnId}:plan:${now}`, at: now, turnId, type: "todo",
				items: plan.flatMap((value) => {
					const row = objectValue(value);
					const step = stringValue(row?.step);
					const status = stringValue(row?.status)?.toLowerCase();
					return step ? [{ text: step, completed: status === "completed", active: status === "inprogress" || status === "in_progress" }] : [];
				}),
			});
		}
		if ((method === "item/started" || method === "item/completed") && params) this.handleItemEvent(events, method, params, turnId, now);
		this.setProgressEvents(session, events);
		this.persist();
		this.publish(session);
		if (method === "turn/completed") void this.drainQueue(session);
	}

	private handleItemEvent(events: ProgressEvent[], method: string, params: JsonObject, turnId: string, at: number): void {
		const item = objectValue(params.item);
		const itemId = stringValue(item?.id) ?? `${at}`;
		const itemType = stringValue(item?.type) ?? "other";
		if (method === "item/started") {
			this.itemNames.set(itemId, itemType);
			events.push({ id: `notify:${turnId}:${itemId}:started`, at, turnId, type: "activity", category: categoryForItem(item), label: labelForItem(item), state: "running" });
			this.appendSubagentEvents(events, item, itemId, turnId, at, "started");
			return;
		}
		if (itemType === "agentMessage" && stringValue(item?.text)) events.push({ id: `notify:${turnId}:${itemId}:recap`, at, turnId, type: "recap", text: item!.text as string });
		events.push({ id: `notify:${turnId}:${itemId}:completed`, at, turnId, type: "activity", category: categoryForItem(item), label: labelForItem(item), state: itemFailed(item) ? "error" : "done" });
		this.appendSubagentEvents(events, item, itemId, turnId, at, "completed");
	}

	private appendSubagentEvents(
		events: ProgressEvent[],
		item: JsonObject | undefined,
		itemId: string,
		turnId: string,
		at: number,
		phase: "started" | "completed",
	): void {
		const type = stringValue(item?.type) ?? "";
		if (!isSubagentItemType(type)) return;
		for (const child of subagentStatesForItem(item, phase)) events.push({
			id: `notify:${turnId}:${itemId}:${phase}:${child.childId}:${child.state}`,
			at,
			turnId,
			type: "subagent",
			childId: child.childId,
			state: child.state,
		});
	}

	private handleServerRequest(rpcId: RpcId, method: string, params: JsonObject | undefined): void {
		const threadId = stringValue(params?.threadId);
		const turnId = stringValue(params?.turnId);
		const itemId = stringValue(params?.itemId);
		const session = threadId ? this.sessions.get(threadId) : undefined;
		if (!session || !threadId || !turnId || !itemId || session.activeTurnId !== turnId) {
			this.respond(rpcId, { decision: "decline" });
			return;
		}
		const requestId = `managed:${threadId}:${turnId}:${itemId}:${String(rpcId)}`;
		const questions = method === "item/tool/requestUserInput" ? parseQuestions(params?.questions) : undefined;
		const kind: ManagedDesktopRequest["kind"] = method === "item/tool/requestUserInput" ? "question" : method.includes("fileChange") ? "file-approval" : "command-approval";
		const detail: ManagedDesktopRequest = {
			requestId, threadId, turnId, itemId, kind,
			summary: kind === "question" ? "Codex needs an answer" : kind === "file-approval" ? "File change approval" : "Command approval",
			createdAt: Date.now(),
			...(questions ? { questions } : {}),
		};
		this.serverRequests.set(requestId, { rpcId, method, detail });
		if (kind === "question" && questions?.length === 1 && questions[0]!.options.length > 0) this.options.onPlanInput({
			requestId, taskId: taskIdFor(threadId), threadId, turnId, itemId, questionIndex: 0, questions,
		});
		const task = this.options.registry.getTask(taskIdFor(threadId));
		if (task) this.options.registry.upsertTask({
			...task,
			status: kind === "question" ? "NEEDS_INPUT" : "APPROVAL",
			request: kind === "question" ? undefined : {
			humanRequired: true,
				requestId, type: kind, target: detail.summary, riskTier: 1, createdAt: detail.createdAt,
				expiresAt: detail.createdAt + 60 * 60_000, decisionPath: null,
			},
			capabilities: {
				...task.capabilities,
				desktop: { ...task.capabilities.desktop, approve: kind !== "question", reject: kind !== "question" },
				device: { ...task.capabilities.device, answerChoice: kind === "question" && !!questions?.[0]?.options.length },
			},
			lastEventAt: Date.now(),
		});
	}

	private clearServerRequest(requestId: string): void {
		const pending = this.serverRequests.get(requestId);
		if (!pending) return;
		this.serverRequests.delete(requestId);
		this.options.onPlanInputCleared(requestId);
		const task = this.options.registry.getTask(taskIdFor(pending.detail.threadId));
		const session = this.sessions.get(pending.detail.threadId);
		if (task && session) this.publish(session, { status: session.activeTurnId ? "RUNNING" : "DONE_UNREAD" });
	}

	private publish(session: StoredManagedSession, override: { status?: Task["status"]; recap?: string } = {}): void {
		const existing = this.options.registry.getTask(taskIdFor(session.threadId));
		const events = this.progressEvents.get(session.threadId) ?? [];
		const reduction = reduceProgressEvents(events, Date.now());
		const executionEventAt = events.reduce((latest, event) => Math.max(latest, event.at), 0);
		const requests = [...this.serverRequests.values()].filter((request) => request.detail.threadId === session.threadId);
		const status = override.status ?? (requests.some((request) => request.detail.kind !== "question") ? "APPROVAL"
			: requests.length > 0 ? "NEEDS_INPUT"
				: session.activeTurnId ? "RUNNING"
					: reduction.terminal === "error" ? "ERROR"
						: reduction.terminal === "interrupted" ? "PAUSED"
							: reduction.terminal ? "DONE_UNREAD" : existing?.status ?? "QUEUED");
		const progress = {
			...emptyTaskProgress(),
			...reduction.progress,
			queueLength: session.queue.filter((message) => message.state === "queued" || message.state === "sending").length,
			queueFailed: session.queue.filter((message) => message.state === "failed").length,
			...(override.recap ? { recap: safeProgressText(override.recap, 220) } : {}),
		};
		const task: Task = {
			taskId: taskIdFor(session.threadId),
			...(session.activeTurnId ? { executionId: session.activeTurnId } : {}),
			agent: "codex",
			ownership: "managed",
			externalId: session.threadId,
			projectId: session.cwd,
			projectLabel: projectLabelFromCwd(session.cwd, "CODEX"),
			cwd: session.cwd,
			titleShort: "Managed Codex task",
			...(session.effort ? { reasoningEffort: session.effort } : {}),
			...(session.model ? { model: session.model } : {}),
			status,
			attentionCount: status === "APPROVAL" || status === "NEEDS_INPUT" || status === "ERROR" || status === "DONE_UNREAD" ? 1 : 0,
			capabilities: taskCapabilities({
				open: true,
				send: true,
				approve: requests.some((request) => request.detail.kind !== "question"),
				reject: requests.some((request) => request.detail.kind !== "question"),
				interrupt: !!session.activeTurnId,
				review: true,
				verify: false,
				changeSettings: true,
				answerChoice: requests.some((request) => request.detail.kind === "question" && request.detail.questions?.length === 1),
			}),
			progress,
			openRef: { kind: "url", value: `codex://threads/${encodeURIComponent(session.threadId)}` },
			source: "app-server-events",
			lastEventAt: override.recap !== undefined || (override.status && override.status !== existing?.status)
				? Date.now() : executionEventAt || existing?.lastEventAt || session.createdAt,
			lastObservedAt: Date.now(),
			lastExecutionActivityAt: session.activeTurnId ? Date.now() : executionEventAt || existing?.lastExecutionActivityAt || session.createdAt,
			startedAt: session.createdAt,
		};
		this.options.registry.upsertTask(task);
	}

	private detailForThread(threadId: string): ManagedTaskDetail | undefined {
		const session = this.sessions.get(threadId);
		const task = this.options.registry.getTask(taskIdFor(threadId));
		if (!session || !task) return undefined;
		return {
			task: structuredClone(task),
			...(session.model ? { model: session.model } : {}),
			queue: structuredClone(session.queue),
			requests: [...this.serverRequests.values()].filter((request) => request.detail.threadId === threadId).map((request) => structuredClone(request.detail)),
		};
	}

	private request(method: string, params: JsonObject): Promise<unknown> {
		const child = this.process;
		if (!child || child.killed) return Promise.reject(new Error("Codex app-server is offline"));
		const id = ++this.nextRpcId;
		return new Promise((resolve, reject) => {
			this.pendingRpc.set(id, { method, resolve, reject });
			try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
			catch (error) { this.pendingRpc.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
		});
	}

	private notify(method: string, params: JsonObject): void {
		this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private respond(id: RpcId, result: JsonObject): void {
		this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	private respondError(id: RpcId, code: number, message: string): void {
		this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
	}

	private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.process !== child) return;
		this.process = undefined;
		for (const pending of this.pendingRpc.values()) pending.reject(error);
		this.pendingRpc.clear();
		this.setStatus("DEGRADED", error.message);
		for (const session of this.sessions.values()) this.publish(session, { status: "ERROR", recap: "Codex app-server disconnected; retry will restore this thread." });
	}

	private requireSession(taskId: string): StoredManagedSession {
		const session = this.sessionFromTaskId(taskId);
		const task = this.options.registry.getTask(taskId);
		if (!session || task?.ownership !== "managed" || task.externalId !== session.threadId) throw new Error("Managed task identity mismatch");
		return session;
	}

	private sessionFromTaskId(taskId: string): StoredManagedSession | undefined {
		return taskId.startsWith("codex:") ? this.sessions.get(taskId.slice("codex:".length)) : undefined;
	}

	private assertQueueCapacity(session: StoredManagedSession, text: string): void {
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > MAX_MESSAGE_BYTES) throw new Error("Message exceeds the 8 KiB limit");
		if (session.queue.length >= MAX_QUEUE_MESSAGES) throw new Error("Queue already contains 20 messages");
		const total = session.queue.reduce((sum, message) => sum + Buffer.byteLength(message.text, "utf8"), 0) + bytes;
		if (total > MAX_QUEUE_BYTES) throw new Error("Queue exceeds the 64 KiB limit");
	}

	private setStatus(status: AppServerStatus["status"], lastError?: string): void {
		this.status = { status, lastPollAt: Date.now(), ...(lastError ? { lastError: safeProgressText(lastError, 300) } : {}) };
		this.options.onStatus(this.getStatus());
	}

	private setProgressEvents(session: StoredManagedSession, events: readonly ProgressEvent[]): void {
		const bounded = normalizeStoredProgressEvents(events).slice(-MAX_PROGRESS_EVENTS);
		this.progressEvents.set(session.threadId, bounded);
		session.progressEvents = structuredClone(bounded);
	}

	private load(): void {
		try {
			const state = JSON.parse(fs.readFileSync(this.options.filePath, "utf8")) as StoredManagedState;
			if ((state.version !== 1 && state.version !== 2) || !Array.isArray(state.sessions)) return;
			for (const session of state.sessions) {
				if (!session?.threadId || !path.isAbsolute(session.cwd) || !Array.isArray(session.queue)) continue;
				const progressEvents = normalizeStoredProgressEvents(session.progressEvents);
				const restored = { ...session, queue: session.queue.slice(0, MAX_QUEUE_MESSAGES), progressEvents };
				this.sessions.set(session.threadId, restored);
				if (progressEvents.length > 0) this.progressEvents.set(session.threadId, progressEvents);
			}
		} catch { /* First launch or invalid private state. */ }
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true, mode: 0o700 });
		const state: StoredManagedState = { version: 2, sessions: [...this.sessions.values()] };
		const temporary = `${this.options.filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, this.options.filePath);
		try { fs.chmodSync(this.options.filePath, 0o600); } catch { /* Best effort. */ }
	}
}

function validatePrompt(text: string): void {
	if (!text.trim()) throw new Error("Message cannot be empty");
	if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Message exceeds the 8 KiB limit");
}

function textInput(text: string): JsonObject {
	return { type: "text", text, text_elements: [] };
}

function parseQuestions(value: unknown): PlanQuestion[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const question = objectValue(candidate);
		const id = stringValue(question?.id);
		const prompt = stringValue(question?.question);
		if (!id || !prompt) return [];
		const options = Array.isArray(question?.options) ? question.options.flatMap((entry) => {
			const option = objectValue(entry);
			const label = stringValue(option?.label);
			return label ? [{ label, description: stringValue(option?.description) ?? label }] : [];
		}) : [];
		return [{ id, header: stringValue(question?.header) ?? "Question", question: safeProgressText(prompt, 180), options }];
	});
}

function normalizeStoredProgressEvents(value: unknown): ProgressEvent[] {
	if (!Array.isArray(value)) return [];
	return value.slice(-MAX_PROGRESS_EVENTS).flatMap((candidate): ProgressEvent[] => {
		const event = objectValue(candidate);
		const id = boundedIdentifier(event?.id);
		const turnId = boundedIdentifier(event?.turnId);
		const at = numberValue(event?.at);
		const type = stringValue(event?.type);
		if (!id || !turnId || at === undefined || !type) return [];
		if (type === "turn.started") return [{ id, at, turnId, type }];
		if (type === "turn.terminal") {
			const terminal = stringValue(event?.terminal);
			return terminal === "completed" || terminal === "error" || terminal === "interrupted" ? [{ id, at, turnId, type, terminal }] : [];
		}
		if (type === "activity") {
			const category = stringValue(event?.category);
			const label = stringValue(event?.label);
			const state = stringValue(event?.state);
			if (!category || !ACTIVITY_CATEGORIES.has(category) || !label || !state || !ACTIVITY_STATES.has(state)) return [];
			return [{ id, at, turnId, type, category: category as Extract<ProgressEvent, { type: "activity" }>["category"], label: safeProgressText(label, 52), state: state as Extract<ProgressEvent, { type: "activity" }>["state"] }];
		}
		if (type === "todo") {
			const items = Array.isArray(event?.items) ? event.items.slice(0, 100).flatMap((candidateItem) => {
				const item = objectValue(candidateItem);
				const text = stringValue(item?.text);
				return text ? [{ text: safeProgressText(text, 64), completed: item?.completed === true, ...(typeof item?.active === "boolean" ? { active: item.active } : {}) }] : [];
			}) : [];
			return [{ id, at, turnId, type, items }];
		}
		if (type === "subagent") {
			const childId = boundedIdentifier(event?.childId);
			const state = stringValue(event?.state);
			return childId && (state === "started" || state === "completed" || state === "error") ? [{ id, at, turnId, type, childId, state }] : [];
		}
		if (type === "input") {
			const label = stringValue(event?.label);
			return [{ id, at, turnId, type, ...(label ? { label: safeProgressText(label, 52) } : {}) }];
		}
		if (type === "queue") {
			const length = numberValue(event?.length);
			const failed = numberValue(event?.failed);
			return length === undefined || failed === undefined ? [] : [{ id, at, turnId, type, length: Math.max(0, Math.floor(length)), failed: Math.max(0, Math.floor(failed)) }];
		}
		if (type === "recap") {
			const recap = stringValue(event?.text);
			return recap ? [{ id, at, turnId, type, text: safeProgressText(recap, 220) }] : [];
		}
		return [];
	});
}

const ACTIVITY_CATEGORIES = new Set(["thinking", "shell", "file", "search", "browser", "plan", "agent", "input", "terminal", "other"]);
const ACTIVITY_STATES = new Set(["running", "done", "error", "waiting"]);

function boundedIdentifier(value: unknown): string | undefined {
	const text = stringValue(value)?.trim();
	return text ? text.slice(0, 240) : undefined;
}

function categoryForItem(item: JsonObject | undefined) {
	const type = stringValue(item?.type) ?? "other";
	if (type === "commandExecution") return "shell" as const;
	if (type === "fileChange" || type === "imageView") return "file" as const;
	if (type === "webSearch") return "search" as const;
	if (type === "reasoning") return "thinking" as const;
	if (isSubagentItemType(type)) return "agent" as const;
	if (type === "mcpToolCall" || type === "dynamicToolCall") return activityCategoryForTool(stringValue(item?.tool) ?? type);
	return "other" as const;
}

function labelForItem(item: JsonObject | undefined): string {
	const type = stringValue(item?.type) ?? "Working";
	if (type === "commandExecution") return "Running command";
	if (type === "fileChange") return "Editing files";
	if (type === "reasoning") return "Thinking";
	if (type === "webSearch") return "Searching web";
	if (isSubagentItemType(type)) return "Sub-agent activity";
	const tool = stringValue(item?.tool);
	return safeProgressText(tool ? tool.replace(/[_-]+/g, " ") : type.replace(/([a-z])([A-Z])/g, "$1 $2"), 44);
}

function isSubagentItemType(type: string): boolean {
	return type === "collabAgentToolCall" || type === "collabToolCall" || type === "subAgentActivity";
}

function realChildIds(item: JsonObject | undefined): string[] {
	const ids = new Set<string>();
	if (Array.isArray(item?.receiverThreadIds)) for (const value of item.receiverThreadIds) {
		const id = boundedIdentifier(value);
		if (id) ids.add(id);
	}
	for (const value of [item?.receiverThreadId, item?.newThreadId, item?.agentThreadId]) {
		const id = boundedIdentifier(value);
		if (id) ids.add(id);
	}
	for (const field of [item?.agentsStates, item?.agentStates]) {
		const states = objectValue(field);
		if (states) for (const key of Object.keys(states)) {
			const id = boundedIdentifier(key);
			if (id) ids.add(id);
		}
	}
	return [...ids];
}

function subagentStatesForItem(
	item: JsonObject | undefined,
	phase: "started" | "completed" | "restored",
): Array<{ childId: string; state: "started" | "completed" | "error" }> {
	const type = stringValue(item?.type) ?? "";
	const childIds = realChildIds(item);
	if (type === "subAgentActivity") {
		const state = stringValue(item?.kind)?.toLowerCase() === "interrupted" ? "completed" as const : "started" as const;
		return childIds.map((childId) => ({ childId, state }));
	}
	const explicit = new Map<string, "started" | "completed" | "error">();
	for (const field of [item?.agentsStates, item?.agentStates]) {
		const states = objectValue(field);
		if (!states) continue;
		for (const [rawChildId, value] of Object.entries(states)) {
			const childId = boundedIdentifier(rawChildId);
			const status = stringValue(objectValue(value)?.status) ?? stringValue(value);
			const state = collabAgentProgressState(status);
			if (childId && state) explicit.set(childId, state);
		}
	}
	if (explicit.size > 0) return [...explicit].map(([childId, state]) => ({ childId, state }));
	const singularStatus = collabAgentProgressState(stringValue(item?.agentStatus) ?? stringValue(item?.receiverStatus));
	if (singularStatus) return childIds.map((childId) => ({ childId, state: singularStatus }));
	if (itemFailed(item)) return childIds.map((childId) => ({ childId, state: "error" as const }));
	if (phase === "completed" && stringValue(item?.tool)?.toLowerCase() === "closeagent") return childIds.map((childId) => ({ childId, state: "completed" as const }));
	// A spawn/resume/send/wait tool completing only means the collab request
	// returned. The receiving thread remains active until its own state says otherwise.
	return childIds.map((childId) => ({ childId, state: "started" as const }));
}

function collabAgentProgressState(value: string | undefined): "started" | "completed" | "error" | undefined {
	const status = value?.replace(/[_-]/g, "").toLowerCase();
	if (status === "pendinginit" || status === "running" || status === "inprogress") return "started";
	if (status === "completed" || status === "interrupted" || status === "shutdown") return "completed";
	if (status === "errored" || status === "error" || status === "failed" || status === "notfound") return "error";
	return undefined;
}

function itemFailed(item: JsonObject | undefined): boolean {
	const status = stringValue(item?.status)?.toLowerCase() ?? "";
	return /fail|error|declin/.test(status) || item?.success === false;
}

function findCodexBinary(): string {
	const candidates = [
		process.env.CODEX_BINARY,
		path.join(os.homedir(), ".local", "bin", "codex"),
		"/opt/homebrew/bin/codex",
		"/usr/local/bin/codex",
	].filter((value): value is string => !!value);
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? "codex";
}

function taskIdFor(threadId: string): string { return `codex:${threadId}`; }
function queueId(): string { return `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function objectValue(value: unknown): JsonObject | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function secondsToMs(value: unknown): number | undefined { const number = numberValue(value); return number === undefined ? undefined : number * 1_000; }
function errorMessage(error: unknown): string { return safeProgressText(error instanceof Error ? error.message : String(error), 300); }
function rpcError(value: unknown): string { const object = objectValue(value); return stringValue(object?.message) ?? "Codex app-server request failed"; }
