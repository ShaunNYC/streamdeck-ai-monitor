/**
 * Stream Deck Neo AI 控制台 — 本地 IPC 协议
 *
 * 传输层：本地回环 WebSocket，固定端口，仅监听 127.0.0.1。见 V4 Direct HID 架构的 IPC 约束。
 * 安全模型:每条写入型消息必须携带 token(见 config.ts 里的 token 文件)。
 * 设备协议只暴露选择、打开、验证和回答选择题；审批与中断只走 Electron 内部桥。
 */

import type { PendingPlanInput, SystemStatus, Task } from "./types.js";

/** Daemon → Client(插件)的事件推送类型。 */
export type ServerEventType = "task.updated" | "task.removed" | "system.status" | "system.snapshot" | "ack" | "error";

/** Client(插件)→ Daemon 的动作请求类型。 */
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
 * 统一消息封套。写入型动作由 Daemon 按动作类型复核 Agent、任务、请求或执行身份。
 */
export interface IpcEnvelope<TPayload = unknown> {
	type: MessageType;
	/** 客户端动作请求自带的关联 ID,便于匹配对应的 ack/error 响应。与 Task.request.requestId 是两个不同的概念。 */
	requestId?: string;
	agentId?: string;
	taskId?: string;
	/** 写入型动作必填;读取/订阅可以省略但服务端仍会校验连接已认证。 */
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

/** 极简运行时校验——只检查形状,不做业务语义校验(业务校验在 Daemon 的 ipc-server.ts 里做)。 */
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

/** 返回 null 而不是抛异常——调用方(WS onmessage)应该把 null 当成"丢弃这条消息,记一条日志"处理。 */
export function decodeEnvelope(raw: string): IpcEnvelope | null {
	try {
		const parsed = JSON.parse(raw);
		return isIpcEnvelope(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
