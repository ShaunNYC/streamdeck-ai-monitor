import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { LocalSocket } from "@streamdeck-supervisor/shared";
import {
	createEnvelope, decodeEnvelope, type AckPayload, type ClientHelloPayload,
	type ErrorPayload, type IpcEnvelope, type PlanAnswerActionPayload, type SystemSnapshotPayload, type TaskActionPayload,
	type DismissCompletedDeviceTasksPayload,
} from "@streamdeck-supervisor/shared";
import { deviceState } from "./state.js";

const IPC_URL = `ws://127.0.0.1:${Number.parseInt(process.env.AI_CONTROL_SUPERVISOR_PORT ?? "17742", 10)}`;
const HEARTBEAT_TIMEOUT_MS = 7_000;

function tokenPath(): string {
	const root = process.env.AI_CONTROL_SUPERVISOR_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "streamdeck-supervisor");
	return path.join(root, "token");
}

export class DaemonClient {
	private socket: WebSocket | undefined;
	private localConnect?: () => LocalSocket;
	private active = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private watchdogTimer: ReturnType<typeof setInterval> | undefined;
	private reconnectAttempt = 0;
	private lastGoodMessageAt = 0;
	private requestCounter = 0;
	private readonly pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

	start(localConnect?: () => LocalSocket): void {
		this.stop();
		this.active = true;
		this.localConnect = localConnect;
		this.watchdogTimer = setInterval(() => this.watchdog(), 1_000);
		this.connect();
	}
	stop(): void {
		this.active = false;
		this.localConnect = undefined;
		if (this.watchdogTimer) clearInterval(this.watchdogTimer);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.watchdogTimer = undefined;
		this.reconnectTimer = undefined;
		this.socket?.close(); this.socket = undefined; this.resolvePending(false);
	}

	sendSelectTask(agent: "codex" | "claude", taskId: string): Promise<boolean> {
		return this.sendAction("action.selectTask", { agent, taskId });
	}
	sendFocusAgent(agent: "codex" | "claude"): Promise<boolean> { return this.sendAction("action.focusAgent", { agent }); }
	sendOpenAgent(agent: "codex" | "claude"): Promise<boolean> { return this.sendAction("action.openAgent", { agent }); }
	sendActivateAgentApp(agent: "codex" | "claude"): Promise<boolean> { return this.sendAction("action.activateAgentApp", { agent }); }
	sendNewChat(agent: "codex" | "claude"): Promise<boolean> { return this.sendAction("action.newChat", { agent }); }
	/** Compatibility alias for older callers; new UI uses action.newChat. */
	sendNewCodexChat(): Promise<boolean> { return this.sendAction("action.newCodexChat", { agent: "codex" }); }
	sendTaskAction(type: "action.dismissDeviceTask" | "action.open" | "action.review" | "action.verify", payload: TaskActionPayload): Promise<boolean> {
		return this.sendAction(type, payload);
	}
	sendPlanAnswer(payload: PlanAnswerActionPayload): Promise<boolean> {
		return this.sendAction("action.answerPlanQuestion", payload);
	}

	sendDismissCompleted(payload: DismissCompletedDeviceTasksPayload): Promise<boolean> {
		return this.sendAction("action.dismissCompletedDeviceTasks", payload);
	}

	private readToken(): string | null { try { return fs.readFileSync(tokenPath(), "utf8").trim() || null; } catch { return null; } }

	private connect(): void {
		if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
		const token = this.readToken();
		if (!token) return this.markOfflineAndRetry();
		const socket = this.localConnect ? this.localConnect() as unknown as WebSocket : new WebSocket(IPC_URL);
		this.socket = socket;
		const onOpen = () => {
			if (!this.active || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
			this.reconnectAttempt = 0;
			const hello: ClientHelloPayload = { client: "direct-hid-device", protocolVersion: 4 };
			socket.send(JSON.stringify(createEnvelope("client.hello", hello, { token })));
		};
		if (this.localConnect) queueMicrotask(onOpen);
		else socket.once("open", onOpen);
		socket.on("message", (raw) => this.handleMessage(raw.toString()));
		socket.on("error", () => this.markOfflineAndRetry());
		socket.once("close", () => { if (this.socket === socket) this.socket = undefined; this.markOfflineAndRetry(); });
	}

	private handleMessage(raw: string): void {
		const envelope = decodeEnvelope(raw);
		if (!envelope) return;
		if (envelope.type === "system.snapshot") {
			const payload = envelope.payload as SystemSnapshotPayload;
			if (!payload?.tasks || !payload?.focus || !payload?.status) return;
			const wasOffline = deviceState.isOffline();
			this.lastGoodMessageAt = Date.now(); deviceState.setSnapshot(payload.tasks, payload.focus, payload.status, payload.planInputs ?? []);
			if (wasOffline) console.log("[device] supervisor online");
			return;
		}
		if (envelope.type === "system.status") {
			this.lastGoodMessageAt = Date.now(); deviceState.setStatus(envelope.payload as SystemSnapshotPayload["status"]); return;
		}
		if (envelope.type === "ack") {
			const ack = envelope.payload as AckPayload; if (ack.forRequestId) this.finishPending(ack.forRequestId, true); return;
		}
		if (envelope.type === "error") {
			const error = envelope.payload as ErrorPayload;
			console.error(`[device] ${error.code}: ${error.message}`);
			if (error.forRequestId) this.finishPending(error.forRequestId, false);
		}
	}

	private sendAction(type: IpcEnvelope["type"], payload: TaskActionPayload | PlanAnswerActionPayload | { agent: "codex" | "claude"; taskId?: string }): Promise<boolean> {
		const token = this.readToken();
		if (!token || !this.socket || this.socket.readyState !== WebSocket.OPEN || deviceState.isOffline()) return Promise.resolve(false);
		const requestId = `device-${Date.now()}-${++this.requestCounter}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.finishPending(requestId, false), 10_000);
			this.pending.set(requestId, { resolve, timer });
			try { this.socket?.send(JSON.stringify(createEnvelope(type, payload, { token, requestId, agentId: payload.agent }))); }
			catch { this.finishPending(requestId, false); }
		});
	}

	private watchdog(): void { if (this.lastGoodMessageAt > 0 && Date.now() - this.lastGoodMessageAt > HEARTBEAT_TIMEOUT_MS) this.markOffline(); }
	private markOffline(): void {
		if (!deviceState.isOffline()) console.warn("[device] supervisor offline; preserving the last task frame");
		deviceState.setOffline(); this.resolvePending(false);
	}
	private markOfflineAndRetry(): void {
		this.markOffline();
		if (!this.active) return;
		if (this.reconnectTimer) return;
		const delays: number[] = [1_000, 2_000, 5_000];
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
	}
	private finishPending(id: string, ok: boolean): void { const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(ok); }
	private resolvePending(ok: boolean): void { for (const id of [...this.pending.keys()]) this.finishPending(id, ok); }
}

export const daemonClient = new DaemonClient();
