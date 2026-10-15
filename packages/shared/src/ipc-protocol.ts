/**
 * Stream Deck Neo AI Console — Local IPC protocol
 *
 * Transport: loopback WebSocket on a fixed port, listening only on 127.0.0.1.
 * Security: every write message must carry a token (see the token file in config.ts).
 * Device actions cover selection, opening, verification, and multiple-choice answers; approvals and interrupts use the internal Electron bridge.
 */

import type { PendingPlanInput, SystemStatus, Task } from "./types.js";

/** Daemon → device client event types. */
export type ServerEventType = "task.updated" | "task.removed" | "system.status" | "system.snapshot" | "ack" | "error";

/** Device client → daemon action request types. */
export type ClientActionType =
	| "client.hello"
	| "action.dismissDeviceTask"
	| "action.dismissCompletedDeviceTasks"
	| "action.selectTask"
	| "action.focusAgent"
	| "action.openAgent"
	| "action.activateAgentApp"
	| "action.newChat"
	| "action.newCodexChat"
	| "action.open"
	| "action.review"
	| "action.verify"
	| "action.answerPlanQuestion";

export type MessageType = ServerEventType | ClientActionType;

/**
 * Shared message envelope. The daemon checks agent, task, request, or execution identity for each write action.
 */
export interface IpcEnvelope<TPayload = unknown> {
	type: MessageType;
	/** Client correlation ID for matching ack/error responses; distinct from Task.request.requestId. */
	requestId?: string;
	agentId?: string;
	taskId?: string;
	/** Required for writes; optional for reads/subscriptions, which still require an authenticated connection. */
	token?: string;
	payload: TPayload;
}

export interface TaskUpdatedPayload {
	task: Task;
}

export interface TaskRemovedPayload {
	taskId: string;
}

export interface ClientHelloPayload {
	client: "direct-hid-device";
	protocolVersion: 4;
}

export interface SystemSnapshotPayload {
	tasks: Task[];
	/** Live Codex app-server choice requests; omitted by older daemons. */
	planInputs?: PendingPlanInput[];
	focus: import("./types.js").UiFocus;
	status: SystemStatus;
}

export type SystemStatusPayload = SystemStatus;

export interface AckPayload {
	ok: true;
	forRequestId?: string;
}

export interface ErrorPayload {
	ok: false;
	forRequestId?: string;
	code: "invalid-token" | "stale-request" | "not-found" | "unauthorized" | "internal-error";
	message: string;
}

export interface TaskActionPayload {
	executionId?: string;
	agent: "codex" | "claude";
	taskId: string;
}

export interface DismissCompletedDeviceTasksPayload {
	/** Clears stopped executions from the shared registry, including desktop and unslotted tasks. */
	agent: "codex" | "claude";
	executions: Array<{ taskId: string; executionId: string }>;
}

export interface SelectTaskActionPayload {
	agent: "codex" | "claude";
	taskId: string;
}

export interface FocusAgentActionPayload {
	agent: "codex" | "claude";
}

export type AgentActionPayload = FocusAgentActionPayload;

export interface PlanAnswerActionPayload {
	agent: "codex";
	taskId: string;
	requestId: string;
	questionId: string;
	optionIndex: number;
}

export function createEnvelope<TPayload>(
	type: MessageType,
	payload: TPayload,
	opts: { requestId?: string; agentId?: string; taskId?: string; token?: string } = {},
): IpcEnvelope<TPayload> {
	return { type, payload, ...opts };
}

/** Minimal runtime shape check. The daemon ipc-server.ts validates business semantics. */
export function isIpcEnvelope(value: unknown): value is IpcEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).type === "string" &&
		"payload" in (value as Record<string, unknown>)
	);
}

export function encodeEnvelope(envelope: IpcEnvelope): string {
	return JSON.stringify(envelope);
}

/** Return null instead of throwing; WebSocket callers should discard and log invalid messages. */
export function decodeEnvelope(raw: string): IpcEnvelope | null {
	try {
		const parsed = JSON.parse(raw);
		return isIpcEnvelope(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
