import fs from "node:fs";
import net from "node:net";
import WebSocket from "ws";
import type { AppServerStatus, PendingPlanInput, PlanQuestion } from "@streamdeck-supervisor/shared";
import { getCodexAppServerSocket } from "./config.js";

type JsonRpcId = string | number;
type JsonRpcMessage = {
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
};

interface ToolQuestion {
	header?: unknown;
	id?: unknown;
	isOther?: unknown;
	isSecret?: unknown;
	question?: unknown;
	options?: unknown;
}

interface ToolOption {
	label?: unknown;
	description?: unknown;
}

interface RequestUserInputParams {
	isBlocking?: unknown;
	itemId?: unknown;
	threadId?: unknown;
	turnId?: unknown;
	questions?: unknown;
}

interface PendingSession {
	input: PendingPlanInput;
	rpcRequestId: JsonRpcId;
	answers: Record<string, { answers: string[] }>;
	elicitationIncremented: boolean;
}

export interface CodexAppServerBridgeOptions {
	getThreadIds: () => string[];
	onInput: (input: PendingPlanInput) => void;
	onCleared: (requestId: string) => void;
	onStatus: (status: AppServerStatus) => void;
	/** Opt-in subscription path for Plan choices. STOP itself never subscribes. */
	planRelayEnabled?: boolean;
	requestTimeoutMs?: number;
	retryDelaysMs?: number[];
	threadRetryDelaysMs?: number[];
}

/**
 * Small JSON-RPC client for the Codex Desktop control socket. Standard mode
 * stays unsubscribed and only performs read/interrupt control. Experimental
 * Plan relay may additionally resume threads it explicitly owns.
 */
export class CodexAppServerBridge {
	private socket: WebSocket | undefined;
	private nextRpcId = 1;
	private readonly requests = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly sessions = new Map<string, PendingSession>();
	private readonly joinedThreads = new Set<string>();
	private readonly threadRetries = new Map<string, { attempt: number; nextAt: number; lastError: string }>();
	private readonly elicitationCleanup = new Map<string, number>();
	private status: AppServerStatus = { status: "OFFLINE", lastPollAt: 0 };
	private stopping = true;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private threadRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryAttempt = 0;
	private connectPromise: Promise<void> | undefined;
	private lastWarning: string | undefined;

	constructor(private readonly options: CodexAppServerBridgeOptions) {}

	getStatus(): AppServerStatus { return { ...this.status }; }

	getPending(requestId: string): PendingPlanInput | undefined {
		return this.sessions.get(requestId)?.input;
	}

	/**
	 * Verify the exact active turn through the read-only API, then interrupt it.
	 * This control path deliberately never calls thread/resume or subscribes.
	 */
	async interrupt(threadId: string, turnId: string): Promise<void> {
		if (!threadId || !turnId) throw new Error("Codex execution identity is missing");
		if (!this.socket || this.status.status !== "OK") throw new Error("Codex app-server is not connected");
		const result = await this.request("thread/read", { threadId, includeTurns: true });
		const thread = objectValue(result)?.thread;
		if (!thread || typeof thread !== "object" || Array.isArray(thread)) throw new Error("Codex thread/read returned no thread");
		const record = thread as Record<string, unknown>;
		if (stringValue(record.id) !== threadId) throw new Error("Codex thread identity changed");
		const runtimeStatus = objectValue(record.status);
		if (stringValue(runtimeStatus?.type) !== "active") throw new Error("Codex thread has no active turn");
		const turns = Array.isArray(record.turns) ? record.turns : [];
		const turn = turns.find((candidate) => {
			const value = objectValue(candidate);
			return stringValue(value?.id) === turnId;
		});
		const turnRecord = objectValue(turn);
		if (!turnRecord || stringValue(turnRecord.status) !== "inProgress") throw new Error("Codex turn is no longer in progress");
		await this.request("turn/interrupt", { threadId, turnId });
	}

	async start(): Promise<void> {
		this.stopping = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		if (this.threadRetryTimer) clearTimeout(this.threadRetryTimer);
		this.threadRetryTimer = undefined;
		await this.beginConnect();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		if (this.status.status === "OK") {
			await Promise.all([...this.sessions.values()]
				.filter((session) => session.elicitationIncremented)
				.map((session) => this.request("thread/decrement_elicitation", { threadId: session.input.threadId }).catch(() => undefined)));
		}
		this.clearSessions(false);
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
		this.resetConnection(new Error("Codex app-server bridge stopped"), false);
		this.setStatus("OFFLINE");
	}

	/** Join newly discovered running threads without disturbing existing sessions. */
	async syncThreads(): Promise<void> {
		if (this.options.planRelayEnabled === false) return;
		if (!this.socket || this.status.status !== "OK") return;
		if (this.threadRetryTimer) clearTimeout(this.threadRetryTimer);
		this.threadRetryTimer = undefined;
		const desiredThreads = new Set(this.options.getThreadIds().filter(Boolean));
		for (const threadId of [...this.joinedThreads]) {
			if (desiredThreads.has(threadId)) continue;
			this.joinedThreads.delete(threadId);
			this.threadRetries.delete(threadId);
			void this.request("thread/unsubscribe", { threadId }).catch(() => undefined);
		}
		for (const threadId of [...this.threadRetries.keys()]) {
			if (!desiredThreads.has(threadId)) this.threadRetries.delete(threadId);
		}
		const now = Date.now();
		for (const threadId of desiredThreads) {
			if (!threadId || this.joinedThreads.has(threadId)) continue;
			const retry = this.threadRetries.get(threadId);
			if (retry && retry.nextAt > now) continue;
			this.joinedThreads.add(threadId);
			try {
				await this.request("thread/resume", { threadId, excludeTurns: true });
				this.threadRetries.delete(threadId);
			} catch (error) {
				this.joinedThreads.delete(threadId);
				if (!this.socket || this.status.status !== "OK") continue;
				const detail = error instanceof Error ? error.message : String(error);
				const previous = this.threadRetries.get(threadId);
				const delays = this.options.threadRetryDelaysMs?.length ? this.options.threadRetryDelaysMs : [5_000, 15_000, 30_000, 60_000, 300_000];
				const attempt = (previous?.attempt ?? 0) + 1;
				const delay = delays[Math.min(attempt - 1, delays.length - 1)]!;
				this.threadRetries.set(threadId, { attempt, nextAt: Date.now() + delay, lastError: detail });
				if (previous?.lastError !== detail) console.warn(`[daemon] unable to join Codex thread ${threadId}: ${detail}; retrying with backoff`);
			}
		}
		this.scheduleThreadRetry();
	}

	async answer(requestId: string, taskId: string, questionId: string, optionIndex: number): Promise<"next" | "complete"> {
		const session = this.sessions.get(requestId);
		if (!session || session.input.taskId !== taskId) throw new Error("Plan input request is no longer active");
		const question = session.input.questions[session.input.questionIndex];
		if (!question || question.id !== questionId) throw new Error("Plan question is no longer active");
		const option = question.options[optionIndex];
		if (!option) throw new Error("Plan option is invalid");
		if (session.answers[question.id]) throw new Error("Plan question was already answered");

		session.answers[question.id] = { answers: [option.label] };
		if (session.input.questionIndex < session.input.questions.length - 1) {
			session.input = { ...session.input, questionIndex: session.input.questionIndex + 1 };
			this.options.onInput(session.input);
			return "next";
		}

		try {
			this.write(createPlanAnswerResponse(session.rpcRequestId, session.answers));
		} catch (error) {
			delete session.answers[question.id];
			throw error;
		}
		this.clearSession(requestId, true);
		return "complete";
	}

	private async beginConnect(): Promise<void> {
		if (this.stopping || this.status.status === "OK") return;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.connect().finally(() => { this.connectPromise = undefined; });
		return this.connectPromise;
	}

	private async connect(): Promise<void> {
		this.setStatus("CONNECTING");
		try {
			await this.openSocket();
			await this.request("initialize", {
				clientInfo: { name: "streamdeck_supervisor", title: "Stream Deck Neo", version: "3.1.0" },
				capabilities: { experimentalApi: true },
			});
			if (this.stopping) throw new Error("Codex app-server bridge stopped");
			this.write({ method: "initialized", params: {} });
			this.retryAttempt = 0;
			this.lastWarning = undefined;
			this.setStatus("OK");
			if (this.options.planRelayEnabled !== false) {
				await this.flushElicitationCleanup();
				await this.syncThreads();
			}
		} catch (error) {
			if (this.stopping) return;
			this.failConnection(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socketPath = getCodexAppServerSocket();
			if (!fs.existsSync(socketPath)) {
				reject(new Error(`control socket missing: ${socketPath}`));
				return;
			}
			const socket = new WebSocket("ws://localhost/", {
				perMessageDeflate: false,
				createConnection: () => net.createConnection({ path: socketPath }),
			});
			this.socket = socket;
			let settled = false;
			let opened = false;
			let timer: ReturnType<typeof setTimeout>;
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve();
			};
			const timeoutMs = this.options.requestTimeoutMs ?? 10_000;
			timer = setTimeout(() => {
				settle(new Error(`WebSocket handshake timed out after ${timeoutMs}ms`));
				socket.terminate();
			}, timeoutMs);
			socket.on("message", (raw) => {
				try { this.handleMessage(JSON.parse(raw.toString()) as JsonRpcMessage); }
				catch (error) { console.warn(`[daemon] invalid app-server message: ${error instanceof Error ? error.message : String(error)}`); }
			});
			socket.once("open", () => { opened = true; settle(); });
			socket.once("error", (error) => {
				const failure = error instanceof Error ? error : new Error(String(error));
				if (!opened) settle(failure);
				else this.handleUnexpectedClose(socket, failure);
			});
			socket.once("close", (code, reason) => {
				const failure = new Error(reason.toString() || `app-server socket closed (${code})`);
				if (!opened) settle(failure);
				else this.handleUnexpectedClose(socket, failure);
			});
		});
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextRpcId++;
		return new Promise((resolve, reject) => {
			const timeoutMs = this.options.requestTimeoutMs ?? 10_000;
			const timer = setTimeout(() => {
				this.requests.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.requests.set(id, { resolve, reject, timer });
			try { this.write({ id, method, params }); }
			catch (error) {
				clearTimeout(timer);
				this.requests.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.method === "item/tool/requestUserInput") {
			if (this.options.planRelayEnabled !== false) this.handleInputRequest(message);
			return;
		}
		if (message.method === "serverRequest/resolved") {
			this.handleServerRequestResolved(message.params);
			return;
		}
		if (message.id === undefined) return;
		const request = this.requests.get(message.id);
		if (!request) return;
		clearTimeout(request.timer);
		this.requests.delete(message.id);
		if (message.error) request.reject(new Error(message.error.message ?? `app-server error ${message.error.code ?? "unknown"}`));
		else request.resolve(message.result);
	}

	private handleInputRequest(message: JsonRpcMessage): void {
		if (message.id === undefined || !message.params || typeof message.params !== "object") return;
		const params = message.params as RequestUserInputParams;
		const threadId = stringValue(params.threadId);
		const turnId = stringValue(params.turnId);
		const itemId = stringValue(params.itemId);
		if (params.isBlocking !== true || !threadId || !turnId || !itemId || !Array.isArray(params.questions)) return;
		const questions = normalizeQuestions(params.questions);
		if (!questions || questions.length === 0) return;
		const requestId = `codex-plan:${threadId}:${itemId}:${String(message.id)}`;
		if (this.sessions.has(requestId)) return;
		const input: PendingPlanInput = { requestId, taskId: `codex:${threadId}`, threadId, turnId, itemId, questionIndex: 0, questions };
		const session: PendingSession = { input, rpcRequestId: message.id, answers: {}, elicitationIncremented: false };
		this.sessions.set(requestId, session);
		this.options.onInput(input);
		void this.request("thread/increment_elicitation", { threadId }).then(() => {
			if (this.sessions.get(requestId) === session) session.elicitationIncremented = true;
			else void this.request("thread/decrement_elicitation", { threadId }).catch(() => this.queueElicitationCleanup(threadId));
		}).catch(() => undefined);
	}

	private handleServerRequestResolved(params: unknown): void {
		if (!params || typeof params !== "object") return;
		const resolved = params as { requestId?: unknown; threadId?: unknown };
		if (typeof resolved.requestId !== "string" && typeof resolved.requestId !== "number") return;
		const threadId = stringValue(resolved.threadId);
		for (const [requestId, session] of this.sessions) {
			if (String(session.rpcRequestId) !== String(resolved.requestId)) continue;
			if (threadId && session.input.threadId !== threadId) continue;
			this.clearSession(requestId, true);
			return;
		}
	}

	private write(message: Record<string, unknown>): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
		this.socket.send(JSON.stringify(message));
	}

	private handleUnexpectedClose(socket: WebSocket, error: Error): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.resetConnection(error, true);
		if (!this.stopping) this.transitionOffline(error.message);
	}

	private failConnection(error: Error): void {
		const detail = error.message;
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
		this.resetConnection(new Error(detail), true);
		this.transitionOffline(detail);
	}

	private resetConnection(error: Error, queueElicitationCleanup: boolean): void {
		this.joinedThreads.clear();
		this.threadRetries.clear();
		if (this.threadRetryTimer) clearTimeout(this.threadRetryTimer);
		this.threadRetryTimer = undefined;
		for (const request of this.requests.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.requests.clear();
		this.clearSessions(queueElicitationCleanup);
	}

	private clearSession(requestId: string, decrementElicitation: boolean): void {
		const session = this.sessions.get(requestId);
		if (!session) return;
		this.sessions.delete(requestId);
		this.options.onCleared(requestId);
		if (decrementElicitation && session.elicitationIncremented) {
			void this.request("thread/decrement_elicitation", { threadId: session.input.threadId })
				.catch(() => this.queueElicitationCleanup(session.input.threadId));
		}
	}

	private clearSessions(queueCleanup: boolean): void {
		for (const [requestId, session] of [...this.sessions]) {
			if (queueCleanup && session.elicitationIncremented) this.queueElicitationCleanup(session.input.threadId);
			this.sessions.delete(requestId);
			this.options.onCleared(requestId);
		}
	}

	private queueElicitationCleanup(threadId: string): void {
		this.elicitationCleanup.set(threadId, (this.elicitationCleanup.get(threadId) ?? 0) + 1);
	}

	private async flushElicitationCleanup(): Promise<void> {
		for (const [threadId, count] of [...this.elicitationCleanup]) {
			let remaining = count;
			while (remaining > 0) {
				try {
					await this.request("thread/decrement_elicitation", { threadId });
					remaining -= 1;
				} catch {
					break;
				}
			}
			if (remaining === 0) this.elicitationCleanup.delete(threadId);
			else this.elicitationCleanup.set(threadId, remaining);
		}
	}

	private transitionOffline(detail: string): void {
		this.setStatus("OFFLINE", detail);
		if (this.lastWarning !== detail) {
			this.lastWarning = detail;
			console.warn(`[daemon] Codex app-server unavailable: ${detail}`);
		}
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.stopping || this.retryTimer) return;
		const delays = this.options.retryDelaysMs?.length ? this.options.retryDelaysMs : [2_000, 5_000, 15_000, 30_000];
		const delay = delays[Math.min(this.retryAttempt, delays.length - 1)]!;
		this.retryAttempt += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.beginConnect();
		}, delay);
	}

	private scheduleThreadRetry(): void {
		if (this.stopping || this.status.status !== "OK" || this.threadRetryTimer || this.threadRetries.size === 0) return;
		const nextAt = Math.min(...[...this.threadRetries.values()].map((retry) => retry.nextAt));
		this.threadRetryTimer = setTimeout(() => {
			this.threadRetryTimer = undefined;
			void this.syncThreads();
		}, Math.max(0, nextAt - Date.now()));
	}

	private setStatus(status: AppServerStatus["status"], lastError?: string): void {
		this.status = { status, lastPollAt: Date.now(), ...(lastError ? { lastError } : {}) };
		this.options.onStatus(this.getStatus());
	}
}

export function normalizeQuestions(value: unknown[]): PlanQuestion[] | null {
	if (value.length === 0 || value.length > 8) return null;
	const questions: PlanQuestion[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") return null;
		const question = raw as ToolQuestion;
		if (question.isOther === true || question.isSecret === true) return null;
		const id = stringValue(question.id);
		const header = stringValue(question.header);
		const prompt = stringValue(question.question);
		if (!id || !header || !prompt || !Array.isArray(question.options) || question.options.length === 0 || question.options.length > 8) return null;
		const options: PlanQuestion["options"] = [];
		for (const rawOption of question.options) {
			if (!rawOption || typeof rawOption !== "object") return null;
			const option = rawOption as ToolOption;
			const label = stringValue(option.label);
			const description = stringValue(option.description) || label;
			if (!label || !description) return null;
			options.push({ label, description });
		}
		questions.push({ id, header, question: prompt, options });
	}
	return questions;
}

export function createPlanAnswerResponse(rpcRequestId: JsonRpcId, answers: Record<string, { answers: string[] }>): Record<string, unknown> {
	return { id: rpcRequestId, result: { answers } };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
