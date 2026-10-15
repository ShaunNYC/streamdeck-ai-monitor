import http from "node:http";
import { isLiveTask, type AdapterStatus, type Task } from "@streamdeck-supervisor/shared";
import { getTokenPath } from "../config.js";
import type { AdapterContext, SupervisorAdapter } from "./types.js";
import { ClaudeHookActivityGate, claudeDecisionResponse, parseClaudeHookEvent, type ClaudeHookEvent } from "./claude-events.js";
import { ClaudeTranscriptWatcher } from "./claude-transcript.js";

const HOOK_HOST = "127.0.0.1";
const HOOK_PORT = Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_HOOK_PORT ?? "17743", 10);
const HOOK_MODE = process.env.AI_CONTROL_SUPERVISOR_CLAUDE_HOOK_MODE === "blocking" ? "blocking" : "observe";

type PendingDecision = {
	task: Task;
	taskId: string;
	requestId: string;
	resolve: (value: "allow" | "deny") => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Stable within one prompt, intentionally renewed for every UserPromptSubmit. */
export class ClaudeExecutionTracker {
	private readonly executionBySession = new Map<string, string>();
	private executionCounter = 0;

	assign(event: ClaudeHookEvent, now = Date.now(), observedTask?: Task): string | undefined {
		const sessionId = event.task.externalId;
		if (event.eventName === "UserPromptSubmit") {
			const executionId = `claude:${sessionId}:${now.toString(36)}:${++this.executionCounter}`;
			this.executionBySession.set(sessionId, executionId);
			return executionId;
		}
		let executionId = this.executionBySession.get(sessionId);
		if (!executionId && (event.eventName === "PreToolUse"
			|| event.eventName === "PostToolUse"
			|| event.eventName === "PostToolUseFailure"
			|| event.eventName === "PermissionRequest"
			|| event.eventName === "Notification")) {
			// The watcher may already have observed this prompt before the first
			// Hook (or after a daemon restart). Keep its existing duration identity.
			executionId = observedTask?.externalId === sessionId && isLiveTask(observedTask)
				? observedTask.executionId ?? String(observedTask.progress.turnStartedAt ?? observedTask.startedAt)
				: `claude:${sessionId}:${now.toString(36)}:${++this.executionCounter}`;
			this.executionBySession.set(sessionId, executionId);
		}
		return executionId;
	}

	clear(sessionId: string): void { this.executionBySession.delete(sessionId); }
	reset(): void { this.executionBySession.clear(); }
}

export class ClaudeHookAdapter implements SupervisorAdapter {
	readonly name = "claude" as const;
	private readonly pending = new Map<string, PendingDecision>();
	private readonly pendingByTask = new Map<string, string[]>();
	private readonly activityGate = new ClaudeHookActivityGate();
	private readonly executionTracker = new ClaudeExecutionTracker();
	private status: AdapterStatus = { status: "OFFLINE", lastPollAt: 0 };
	private server: http.Server | undefined;
	private transcriptWatcher: ClaudeTranscriptWatcher | undefined;

	constructor(
		private readonly context: AdapterContext,
		private readonly token: string,
		transcriptDirectory?: string,
		private readonly hookMode: "observe" | "blocking" = HOOK_MODE,
		desktopSessionDirectory?: string,
		private readonly acceptHooks = true,
	) {
		this.transcriptWatcher = new ClaudeTranscriptWatcher(
			transcriptDirectory,
			(task) => this.context.upsertTask(task),
			(error) => this.setStatus("DEGRADED", error.message),
			desktopSessionDirectory,
		);
	}

	getStatus(): AdapterStatus {
		return { ...this.status };
	}

	async start(): Promise<void> {
		if (this.acceptHooks) {
			this.server = http.createServer((request, response) => void this.handleRequest(request, response));
			await new Promise<void>((resolve, reject) => {
				this.server?.once("error", reject);
				this.server?.listen(HOOK_PORT, HOOK_HOST, () => resolve());
			});
		}
		this.setStatus("OK");
		await this.transcriptWatcher?.start();
		if (this.server) console.log(`[claude] hook receiver listening on http://${HOOK_HOST}:${HOOK_PORT}`);
	}

	async stop(): Promise<void> {
		for (const taskId of [...this.pendingByTask.keys()]) this.cancelTaskPending(taskId, true);
		this.executionTracker.reset();
		this.transcriptWatcher?.stop();
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		this.server = undefined;
	}

	decide(task: Task, requestId: string, decision: "allow" | "deny"): boolean {
		const pending = this.pending.get(requestId);
		if (!pending || pending.taskId !== task.taskId || this.pendingByTask.get(task.taskId)?.[0] !== requestId) return false;
		return this.settlePending(task.taskId, requestId, decision, "decision");
	}

	hasPendingDecision(taskId: string, requestId: string): boolean {
		const pending = this.pending.get(requestId);
		return pending?.taskId === taskId && this.pendingByTask.get(taskId)?.[0] === requestId;
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (request.method !== "POST" || request.url !== "/hook/claude") {
			response.writeHead(404).end();
			return;
		}
		const suppliedToken = request.headers["x-ai-control-token"];
		if (suppliedToken !== this.token) {
			response.writeHead(401).end();
			return;
		}
		let permissionRequest = false;
		try {
			const body = await readJson(request);
			permissionRequest = isPermissionRequest(body);
			const parsed = parseClaudeHookEvent(body, this.hookMode);
			if (!parsed) {
				response.writeHead(204).end();
				return;
			}
			const executionId = this.executionTracker.assign(parsed, Date.now(), this.context.registry.getTask(parsed.task.taskId));
			if (executionId) parsed.task.executionId = executionId;
			parsed.task.capabilities = {
				...parsed.task.capabilities,
				desktop: {
					...parsed.task.capabilities.desktop,
					interrupt: parsed.task.status === "RUNNING" && !!parsed.task.processId && !!executionId,
				},
			};
			if (!this.activityGate.accept(parsed)) {
				if (parsed.terminal) this.executionTracker.clear(parsed.task.externalId);
				this.setStatus("OK");
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			if (this.hookMode === "blocking" && parsed.request && parsed.task.status === "APPROVAL") {
				// Register the resolver before publishing the task. The device must never
				// see a bright decision key before the matching Hook can accept it.
				const pendingDecision = this.waitForDecision(parsed.task, parsed.request.requestId, parsed.request.expiresAt);
				const onClosed = () => {
					if (!response.writableEnded) this.expirePendingDecision(parsed.task.taskId, parsed.request!.requestId);
				};
				response.once("close", onClosed);
				if (parsed.terminal) this.executionTracker.clear(parsed.task.externalId);
				this.setStatus("OK");
				const decision = await pendingDecision;
				response.off("close", onClosed);
				if (response.destroyed) return;
				this.sendJson(response, claudeDecisionResponse("PermissionRequest", decision, decision === "deny" ? "Stream Deck approval was denied or expired." : ""));
				return;
			}
			if (this.pendingByTask.has(parsed.task.taskId)) {
				if (parsed.terminal) this.cancelTaskPending(parsed.task.taskId, false);
				else {
					// Parallel lifecycle Hooks must not hide a still-blocking permission
					// request from the device. The queued PermissionRequest remains the
					// authoritative state until it is decided, disconnected or expires.
					this.setStatus("OK");
					response.writeHead(200, { "content-type": "application/json" }).end("{}");
					return;
				}
			}
			this.context.upsertTask(parsed.task);
			if (parsed.terminal) this.executionTracker.clear(parsed.task.externalId);
			this.setStatus("OK");
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		} catch (error) {
			this.setStatus("DEGRADED", error instanceof Error ? error.message : String(error));
			this.sendJson(response, permissionRequest
				? claudeDecisionResponse("PermissionRequest", "deny", "Neo approval service could not process this request.")
				: {});
		}
	}

	private waitForDecision(task: Task, requestId: string, expiresAt: number): Promise<"allow" | "deny"> {
		return new Promise((resolve) => {
			const remaining = Math.max(0, expiresAt - Date.now());
			const timer = setTimeout(() => this.expirePendingDecision(task.taskId, requestId), remaining);
			this.pending.set(requestId, { task, taskId: task.taskId, requestId, resolve, timer });
			const queue = this.pendingByTask.get(task.taskId) ?? [];
			queue.push(requestId);
			this.pendingByTask.set(task.taskId, queue);
			if (queue.length === 1) this.context.upsertTask(task);
		});
	}

	private expirePendingDecision(taskId: string, requestId: string): boolean {
		return this.settlePending(taskId, requestId, "deny", "expired");
	}

	private settlePending(taskId: string, requestId: string, decision: "allow" | "deny", reason: "decision" | "expired"): boolean {
		const pending = this.pending.get(requestId);
		const queue = this.pendingByTask.get(taskId);
		if (!pending || pending.taskId !== taskId || !queue) return false;
		const index = queue.indexOf(requestId);
		if (index < 0) return false;
		const wasHead = index === 0;
		const nextId = wasHead ? queue[1] : undefined;
		const next = nextId ? this.pending.get(nextId) : undefined;
		if (wasHead && !next && reason === "decision" && !this.context.registry.resolveApproval(taskId, requestId)) return false;

		clearTimeout(pending.timer);
		this.pending.delete(requestId);
		queue.splice(index, 1);
		if (queue.length === 0) this.pendingByTask.delete(taskId);
		if (wasHead) {
			if (next) this.context.upsertTask(next.task);
			else if (reason === "expired") this.context.registry.markRequestStale(taskId);
		}
		pending.resolve(decision);
		return true;
	}

	private cancelTaskPending(taskId: string, markStale: boolean): void {
		const queue = this.pendingByTask.get(taskId);
		if (!queue) return;
		if (markStale) this.context.registry.markRequestStale(taskId);
		this.pendingByTask.delete(taskId);
		for (const requestId of queue) {
			const pending = this.pending.get(requestId);
			if (!pending) continue;
			clearTimeout(pending.timer);
			this.pending.delete(requestId);
			pending.resolve("deny");
		}
	}

	private setStatus(status: AdapterStatus["status"], lastError?: string): void {
		this.status = { status, lastPollAt: Date.now(), ...(lastError ? { lastError } : {}) };
		this.context.setStatus(this.name, status, lastError);
	}

	private sendJson(response: http.ServerResponse, payload: unknown): void {
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
	}
}

function isPermissionRequest(input: unknown): boolean {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const event = (input as Record<string, unknown>).hook_event_name ?? (input as Record<string, unknown>).hookEventName;
	return event === "PermissionRequest";
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
			if (body.length > 1_000_000) request.destroy(new Error("hook body too large"));
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

export function claudeHookEnvironment(mode: "observe" | "blocking" = HOOK_MODE): { port: number; mode: "observe" | "blocking"; tokenPath: string } {
	return { port: HOOK_PORT, mode, tokenPath: getTokenPath() };
}
