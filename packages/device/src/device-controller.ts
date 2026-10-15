import { listStreamDecks, openStreamDeck, type StreamDeck, type StreamDeckButtonControlDefinition } from "@elgato-stream-deck/node";
import { isClearableTask, isLiveTask, isPendingAttentionTask, taskExecutionKey, type AgentKind, type DeviceConnectionStatus, type NeoDeviceInfo, type Task } from "@streamdeck-supervisor/shared";
import { daemonClient } from "./daemon-client.js";
import {
	COLORS, INFOBAR_MARQUEE_FRAME_MS, infobarMarqueeOffset, layoutInfobar, rasterizeSvg, renderEmptySlot,
	renderFailureTile, renderInfobar, renderPressedTile, renderSuccessTile, renderMainTile, renderPlanChoiceTile,
	renderSystemTile, renderTaskCard, renderTaskColumnKey, type InfobarOptions, type MainTileModel,
} from "./render.js";
import { DeviceState, deviceState } from "./state.js";

type Page = -3 | -2 | -1 | 0 | 1 | 2 | 3;
type Feedback = { key: number; message: string; detail?: string; success: boolean; expiresAt: number };
type ApprovalNotice = {
	label: "RESOLVED ELSEWHERE" | "APPROVAL EXPIRED";
	detail: string;
	kind: "resolved" | "expired";
};
type TrackedApproval = { taskId: string; requestId: string; agent: AgentKind; expiresAt: number };
type LocalDecision = { accepted: boolean; pendingNotice?: ApprovalNotice };
type PhysicalPress = {
	key: number;
	page: Page;
	baseSvg: string;
	startedAt: number;
	firstFrameSvg: string;
	firstFrameBuffer: Promise<Uint8Array | undefined>;
	firstFrameShownAt?: number;
	slowWarningLogged?: boolean;
	releasedAt?: number;
	releaseProgress?: number;
};

const KEY_COUNT = 8;
const TOUCH_POINT_KEYS: Record<AgentKind, number> = { codex: 8, claude: 9 };
const PAGE_AGENT: Partial<Record<Page, AgentKind>> = { [-3]: "codex", [-2]: "codex", [-1]: "codex", 1: "claude", 2: "claude", 3: "claude" };
const PRESS_DOWN_MS = 70;
const PRESS_UP_MS = 160;
const PRESS_FRAME_MS = 16;
const PRESS_MIN_VISIBLE_PROGRESS = 0.25;
const PRESS_FEEDBACK_BUDGET_MS = 100;
export const SUCCESS_RECAP_VISIBLE_MS = 30_000;

export type TerminalInfobarState =
	| { kind: "error"; agent: AgentKind; detail?: string; expiresAt?: number }
	| { kind: "recap"; recap: string; expiresAt: number };

/** Select terminal LCD content independently from the retained process-card focus. */
export function resolveTerminalInfobar(tasks: readonly Task[], now = Date.now()): TerminalInfobarState | undefined {
	const error = tasks
		.filter((task) => task.status === "ERROR" && isPendingAttentionTask(task, now))
		.sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
	if (error) return {
		kind: "error",
		agent: error.agent,
		...(error.progress.recap ? { detail: error.progress.recap } : {}),
		...(error.attentionExpiresAt !== undefined ? { expiresAt: error.attentionExpiresAt } : {}),
	};

	const completed = tasks
		.filter((task) => (task.status === "DONE" || task.status === "DONE_UNREAD")
			&& !!task.progress.recap?.trim()
			&& now < task.lastEventAt + SUCCESS_RECAP_VISIBLE_MS)
		.sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
	if (!completed) return undefined;
	return {
		kind: "recap",
		recap: completed.progress.recap!,
		expiresAt: completed.lastEventAt + SUCCESS_RECAP_VISIBLE_MS,
	};
}

export interface DeviceControllerOptions {
	serialNumber?: string;
	onStatus?: (status: DeviceConnectionStatus) => void;
}

export async function scanNeoDevices(): Promise<NeoDeviceInfo[]> {
	const devices = await listStreamDecks();
	return devices
		.filter((device) => String(device.model).toLowerCase().includes("neo"))
		.map((device) => ({ model: String(device.model), path: device.path, ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}) }));
}

export class DeviceController {
	private deck: StreamDeck | undefined;
	private page: Page = 0;
	private readonly pressedAt = new Map<number, number>();
	private overflowIndex: Record<AgentKind, number> = { codex: 0, claude: 0 };
	private feedback: Feedback | undefined;
	private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	private infobarNotice: (ApprovalNotice & { expiresAt: number }) | undefined;
	private infobarNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	private terminalInfobarTimer: ReturnType<typeof setTimeout> | undefined;
	private terminalInfobarExpiresAt: number | undefined;
	private lcdAnimationTimer: ReturnType<typeof setTimeout> | undefined;
	private lcdContentKey: string | undefined;
	private lcdContentStartedAt = 0;
	private lcdRenderRequested = false;
	private readonly trackedApprovals = new Map<string, TrackedApproval>();
	private approvalTrackingInitialized = false;
	private readonly localDecisions = new Map<string, LocalDecision>();
	private readonly physicalPresses = new Map<number, PhysicalPress>();
	private physicalPressTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private clearHold?: ReturnType<typeof setTimeout>;
	private heldKey?: number;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private unsubscribeState: (() => void) | undefined;
	private renderRequested = false;
	private readonly urgentRenderKeys = new Set<number>();
	private renderInProgress = false;
	private stopped = false;
	private lastAttentionGeneration = 0;
	private lastFrame = new Map<string, string>();
	private connectionStatus: DeviceConnectionStatus = { state: "STOPPED", devices: [] };

	constructor(private readonly options: DeviceControllerOptions = {}) {}

	getConnectionStatus(): DeviceConnectionStatus {
		return structuredClone(this.connectionStatus);
	}

	async start(): Promise<void> {
		this.stopped = false;
		this.setConnectionStatus({ state: "SEARCHING", devices: [], ...(this.options.serialNumber ? { selectedSerialNumber: this.options.serialNumber } : {}) });
		this.lastAttentionGeneration = deviceState.getAttentionGeneration();
		this.unsubscribeState = deviceState.subscribe(() => this.handleStateChange());
		this.ticker = setInterval(() => this.requestRender(), 80);
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.clearHold) clearTimeout(this.clearHold);
		this.clearFeedback();
		this.clearInfobarNotice();
		this.clearTerminalInfobarExpiry();
		this.clearLcdAnimation();
		this.localDecisions.clear();
		this.trackedApprovals.clear();
		this.approvalTrackingInitialized = false;
		this.clearPhysicalPress();
		this.unsubscribeState?.();
		this.unsubscribeState = undefined;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ticker) clearInterval(this.ticker);
		const deck = this.deck;
		this.deck = undefined;
		this.lcdRenderRequested = false;
		if (deck) await deck.close().catch(() => undefined);
		this.setConnectionStatus({ state: "STOPPED", devices: [] });
	}

	private handleStateChange(): void { this.requestRender(); }

	private currentVisibleApproval(): TrackedApproval | undefined {
		const agent = deviceState.getActiveAgent();
		const task = deviceState.getSelectedTask(agent);
		if (!agent || !task?.request || task.status !== "APPROVAL") return undefined;
		return { taskId: task.taskId, requestId: task.request.requestId, agent, expiresAt: task.request.expiresAt };
	}

	private reconcileApprovalTracking(): void {
		const current = this.currentVisibleApproval();
		if (!this.approvalTrackingInitialized) {
			this.approvalTrackingInitialized = true;
			if (current) this.trackedApprovals.set(current.requestId, current);
			return;
		}
		for (const previous of this.trackedApprovals.values()) {
			const previousTask = deviceState.getTask(previous.taskId);
			const exactRequestStillExists = previousTask?.status === "APPROVAL"
				&& previousTask.request?.requestId === previous.requestId;
			if (exactRequestStillExists) continue;
			const expired = previousTask?.status === "STALE" || previous.expiresAt <= Date.now();
			const notice: ApprovalNotice = {
				label: expired ? "APPROVAL EXPIRED" : "RESOLVED ELSEWHERE",
				detail: `${previous.agent.toUpperCase()} · NO ACTION SENT`,
				kind: expired ? "expired" : "resolved",
			};
			const local = this.localDecisions.get(previous.requestId);
			if (local?.accepted) this.deleteLocalDecision(previous.requestId);
			else if (local) local.pendingNotice = notice;
			else this.showInfobarNotice(notice);
			this.trackedApprovals.delete(previous.requestId);
		}
		if (current) this.trackedApprovals.set(current.requestId, current);
		for (const [requestId, local] of this.localDecisions) {
			if (local.accepted && !this.approvalRequestExists(requestId)) this.deleteLocalDecision(requestId);
		}
	}

	private approvalRequestExists(requestId: string): boolean {
		return ([...deviceState.getTasks("codex"), ...deviceState.getTasks("claude")])
			.some((task) => task.status === "APPROVAL" && task.request?.requestId === requestId);
	}


	private async connect(): Promise<void> {
		if (this.stopped || this.deck) return;
		this.setConnectionStatus({ ...this.connectionStatus, state: "SEARCHING", lastError: undefined });
		try {
			const devices = await scanNeoDevices();
			if (devices.length === 0) {
				this.setConnectionStatus({ state: "NOT_FOUND", devices: [], ...(this.options.serialNumber ? { selectedSerialNumber: this.options.serialNumber } : {}) });
				return this.scheduleReconnect();
			}
			const neo = this.options.serialNumber
				? devices.find((device) => device.serialNumber === this.options.serialNumber)
				: devices.length === 1 ? devices[0] : undefined;
			if (!neo) {
				this.setConnectionStatus({
					state: devices.length > 1 && !this.options.serialNumber ? "MULTIPLE" : "NOT_FOUND",
					devices,
					...(this.options.serialNumber ? { selectedSerialNumber: this.options.serialNumber } : {}),
				});
				return this.scheduleReconnect();
			}
			const deck = await openStreamDeck(neo.path, { resetToLogoOnClose: true });
			this.deck = deck;
			this.lastFrame.clear();
			deck.on("down", (control) => { if (control.type === "button") this.handleDown(control); });
			deck.on("up", (control) => { if (control.type === "button") void this.handleUp(control); });
			deck.on("error", (error) => this.handleDeviceError(error));
			await deck.setBrightness(70);
			console.log(`[device] connected: ${deck.PRODUCT_NAME}`);
			this.setConnectionStatus({
				state: "CONNECTED",
				devices,
				...(neo.serialNumber ? { selectedSerialNumber: neo.serialNumber } : {}),
				productName: deck.PRODUCT_NAME,
			});
			this.requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[device] waiting for Neo: ${message}`);
			this.setConnectionStatus({
				...this.connectionStatus,
				state: /busy|access|claim|open/i.test(message) ? "BUSY" : "ERROR",
				lastError: message,
			});
			this.scheduleReconnect();
		}
	}

	private handleDeviceError(error: unknown): void {
		console.error(`[device] disconnected: ${error instanceof Error ? error.message : String(error)}`);
		const deck = this.deck;
		this.deck = undefined;
		this.clearLcdAnimation();
		this.lcdRenderRequested = false;
		this.lastFrame.clear();
		void deck?.close().catch(() => undefined);
		this.setConnectionStatus({ ...this.connectionStatus, state: "ERROR", lastError: error instanceof Error ? error.message : String(error) });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, 2_000);
	}

	private setConnectionStatus(status: DeviceConnectionStatus): void {
		this.connectionStatus = status;
		this.options.onStatus?.(this.getConnectionStatus());
	}

	private handleDown(control: StreamDeckButtonControlDefinition): void {
		const key = control.index;
		const now = Date.now();
		if (this.page !== 0 && key >= 4 && key < 8) {
			const task = deviceState.getDisplayTask(PAGE_AGENT[this.page]!, (Math.abs(this.page)-1)*4 + key%4).task;
			const slot = task && deviceState.getSlot(task);
			if (task && slot && ["DONE","DONE_UNREAD","PAUSED","ERROR","STALE"].includes(task.status)) {
				const page = this.page;
				this.clearHold = setTimeout(() => {
					if (this.page !== page) return;
					this.heldKey = key;
					void daemonClient.sendTaskAction("action.dismissDeviceTask", {agent: task.agent, taskId: task.taskId, executionId: slot.executionId}).then(ok => { if (!ok) this.showFeedback(key,"CLEAR FAILED"); });
				}, 1000);
			}
		}
		this.pressedAt.set(key, now);
		const pressArtwork = this.getPressArtwork(key);
		if (pressArtwork) this.beginPhysicalPress(key, pressArtwork, now);
	}

	private async handleUp(control: StreamDeckButtonControlDefinition): Promise<void> {
		const key = control.index;
		if (this.clearHold) clearTimeout(this.clearHold);
		if (this.heldKey === key) { this.heldKey = undefined; this.pressedAt.delete(key); this.releasePhysicalPress(key); return; }
		this.pressedAt.delete(key);
		this.releasePhysicalPress(key);

		if (key === 8 || key === 9) {
			return this.movePage(key === 8 ? -1 : 1);
		}
		if (key < 0 || key >= KEY_COUNT) return;
		if (deviceState.isOffline() || deviceState.isSetup()) return;

		if (this.page === 0) await this.handleMainKey(key);
		else await this.handleTaskKey(key, PAGE_AGENT[this.page]!);
	}

	private movePage(delta: -1 | 1): void {
		const next = nextContentPage(deviceState, this.page, delta);
		if (next === undefined) return;
		const leavingAgent = next === 0 ? PAGE_AGENT[this.page] : undefined;
		const executions = leavingAgent ? deviceState.getTasks(leavingAgent)
			.filter(isClearableTask)
			.map(task => ({ taskId: task.taskId, executionId: taskExecutionKey(task) })) : [];
		this.clearPhysicalPress();
		this.clearLcdAnimation();
		this.page = next;
		this.clearFeedback();
		this.requestRender();
		if (leavingAgent && executions.length) {
			void daemonClient.sendDismissCompleted({ agent: leavingAgent, executions }).then(ok => {
				if (!ok && !this.stopped) this.showFeedback(0, "CLEAR FAILED");
			});
		}
	}

	private async handleTaskKey(key: number, agent: AgentKind): Promise<void> {
		const display = deviceState.getDisplayTask(agent, (Math.abs(this.page)-1)*4 + key%4);
		if (!display.task) return;
		const task = display.task;
		await daemonClient.sendSelectTask(agent, task.taskId);
		if (!await daemonClient.sendTaskAction("action.open", { agent, taskId: task.taskId })) this.showFeedback(key, "OPEN FAILED");
	}

	private async handleMainKey(key: number): Promise<void> {
		const model = buildMainTileModels(deviceState, deviceState.isOffline() || deviceState.isSetup())[key];
		if (!model?.actionable) return;
		if (key === 0 || key === 3) {
			const agent: AgentKind = key === 0 ? "codex" : "claude";
			const ok = await daemonClient.sendActivateAgentApp(agent);
			if (!ok) this.showFeedback(key, "APP FAILED");
			return;
		}
		if (key === 1 || key === 2) {
			const agent: AgentKind = key === 1 ? "codex" : "claude";
			const ok = await daemonClient.sendOpenAgent(agent);
			if (!ok) this.showFeedback(key, "OPEN FAILED");
			return;
		}
		if (key === 4) {
			const ok = await daemonClient.sendNewChat(deviceState.getNewChatAgent());
			if (!ok) this.showFeedback(key, "NEW FAILED");
			return;
		}
		// ACTIVITY, PROGRESS and AGENTS are deliberately inert status cards.
	}

	private beginLocalDecision(requestId: string): void {
		this.deleteLocalDecision(requestId);
		this.localDecisions.set(requestId, { accepted: false });
	}

	private finishLocalDecision(requestId: string, accepted: boolean): void {
		const local = this.localDecisions.get(requestId);
		if (!local) return;
		if (!accepted) {
			if (local.pendingNotice) this.showInfobarNotice(local.pendingNotice);
			this.deleteLocalDecision(requestId);
			return;
		}
		local.accepted = true;
		if (local.pendingNotice) return this.deleteLocalDecision(requestId);
	}

	private deleteLocalDecision(requestId: string): void {
		this.localDecisions.delete(requestId);
	}

	private showFeedback(key: number, message: string, options: { success?: boolean; detail?: string; durationMs?: number } = {}): void {
		const previousKey = this.feedback?.key;
		this.clearFeedback();
		if (previousKey !== undefined && previousKey !== key) this.requestKeyRender(previousKey);
		const durationMs = options.durationMs ?? 700;
		const expiresAt = Date.now() + durationMs;
		this.feedback = { key, message, detail: options.detail, success: options.success === true, expiresAt };
		this.requestKeyRender(key);
		this.feedbackTimer = setTimeout(() => {
			if (!this.feedback || this.feedback.expiresAt > Date.now()) return;
			this.clearFeedback();
			this.requestKeyRender(key);
		}, durationMs + 25);
	}

	private clearFeedback(): void {
		if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
		this.feedbackTimer = undefined;
		this.feedback = undefined;
	}

	private showInfobarNotice(notice: ApprovalNotice): void {
		this.clearInfobarNotice();
		this.infobarNotice = { ...notice, expiresAt: Date.now() + 1_500 };
		this.requestRender();
		this.infobarNoticeTimer = setTimeout(() => {
			if (!this.infobarNotice || this.infobarNotice.expiresAt > Date.now()) return;
			this.clearInfobarNotice();
			this.requestRender();
		}, 1_525);
	}

	private clearInfobarNotice(): void {
		if (this.infobarNoticeTimer) clearTimeout(this.infobarNoticeTimer);
		this.infobarNoticeTimer = undefined;
		this.infobarNotice = undefined;
	}

	private scheduleTerminalInfobarExpiry(expiresAt: number | undefined, now = Date.now()): void {
		if (expiresAt !== undefined && expiresAt > now
			&& this.terminalInfobarExpiresAt === expiresAt && this.terminalInfobarTimer) return;
		this.clearTerminalInfobarExpiry();
		if (expiresAt === undefined || expiresAt <= now) return;
		this.terminalInfobarExpiresAt = expiresAt;
		this.terminalInfobarTimer = setTimeout(() => {
			this.terminalInfobarTimer = undefined;
			this.terminalInfobarExpiresAt = undefined;
			this.requestRender();
		}, Math.max(0, expiresAt - now));
	}

	private clearTerminalInfobarExpiry(): void {
		if (this.terminalInfobarTimer) clearTimeout(this.terminalInfobarTimer);
		this.terminalInfobarTimer = undefined;
		this.terminalInfobarExpiresAt = undefined;
	}

	private beginPhysicalPress(key: number, baseSvg: string, startedAt = Date.now()): void {
		const firstFrameSvg = renderPressedTile(baseSvg, PRESS_MIN_VISIBLE_PROGRESS);
		// Rasterization is the expensive part of a press frame. Start it at
		// key-down so it overlaps any HID write already in flight; the urgent
		// renderer can then send the prepared frame as soon as the device is free.
		const firstFrameBuffer = rasterizeSvg(firstFrameSvg, 96, 96).catch(() => undefined);
		this.physicalPresses.set(key, { key, page: this.page, baseSvg, startedAt, firstFrameSvg, firstFrameBuffer });
		this.requestKeyRender(key);
		this.schedulePhysicalPressFrame();
	}

	private releasePhysicalPress(key: number): void {
		const press = this.physicalPresses.get(key);
		if (!press) return;
		const now = Date.now();
		if (press.firstFrameShownAt === undefined) {
			this.physicalPresses.delete(key);
			this.requestKeyRender(key);
			this.stopPhysicalPressTimerIfIdle();
			return;
		}
		const releaseProgress = this.pressProgress(press, now);
		if (releaseProgress <= 0) return this.clearPhysicalPress(key);
		this.physicalPresses.set(key, { ...press, releasedAt: now, releaseProgress });
		this.requestKeyRender(key);
		this.schedulePhysicalPressFrame();
	}

	private clearPhysicalPress(key?: number): void {
		if (key === undefined) this.physicalPresses.clear();
		else this.physicalPresses.delete(key);
		this.stopPhysicalPressTimerIfIdle();
	}

	private schedulePhysicalPressFrame(): void {
		if (this.physicalPressTimer || !this.hasAnimatingPhysicalPress()) return;
		this.physicalPressTimer = setTimeout(() => {
			this.physicalPressTimer = undefined;
			const now = Date.now();
			for (const [key, press] of this.physicalPresses) {
				const progress = this.pressProgress(press, now);
				if (press.firstFrameShownAt === undefined && !press.slowWarningLogged && now - press.startedAt > PRESS_FEEDBACK_BUDGET_MS) {
					press.slowWarningLogged = true;
					console.warn(`[device] slow press feedback: key=${key} latency>${PRESS_FEEDBACK_BUDGET_MS}ms`);
				}
				if (press.releasedAt !== undefined && progress <= 0) {
					this.physicalPresses.delete(key);
					this.requestKeyRender(key);
					continue;
				}
				this.requestKeyRender(key);
			}
			this.schedulePhysicalPressFrame();
		}, PRESS_FRAME_MS);
	}

	private pressProgress(press: PhysicalPress, now: number): number {
		if (press.releasedAt !== undefined) {
			return Math.max(0, (press.releaseProgress ?? 0) * (1 - (now - press.releasedAt) / PRESS_UP_MS));
		}
		return Math.max(PRESS_MIN_VISIBLE_PROGRESS, Math.min(1, (now - press.startedAt) / PRESS_DOWN_MS));
	}

	private hasAnimatingPhysicalPress(): boolean {
		const now = Date.now();
		return [...this.physicalPresses.values()].some((press) => press.firstFrameShownAt === undefined || press.releasedAt !== undefined || this.pressProgress(press, now) < 1);
	}

	private stopPhysicalPressTimerIfIdle(): void {
		if (this.physicalPresses.size > 0 && this.hasAnimatingPhysicalPress()) return;
		if (this.physicalPressTimer) clearTimeout(this.physicalPressTimer);
		this.physicalPressTimer = undefined;
	}

	/** Freeze actionability and artwork at key-down so accepted input can finish its animation. */
	private getPressArtwork(key: number): string | undefined {
		if (key < 0 || key >= KEY_COUNT || deviceState.isOffline() || deviceState.isSetup()) return undefined;
		if (this.page === 0) {
			const model = buildMainTileModels(deviceState)[key];
			return model?.actionable ? renderMainTile(model) : undefined;
		}
		const agent = PAGE_AGENT[this.page];
		if (!agent) return undefined;
		const item = deviceState.getDisplayTask(agent, (Math.abs(this.page)-1)*4 + key%4);
		return item.task ? renderTaskColumnKey(item.task, key >= 4, deviceState.getSlot(item.task)?.durationMs) : undefined;
	}

	private requestRender(): void {
		this.renderRequested = true;
		this.ensureRenderLoop();
	}

	private requestLcdRender(): void {
		this.lcdRenderRequested = true;
		this.ensureRenderLoop();
	}

	private requestKeyRender(key: number): void {
		if (key < 0 || key >= KEY_COUNT) return;
		this.urgentRenderKeys.add(key);
		this.ensureRenderLoop();
	}

	private ensureRenderLoop(): void {
		if (!this.renderInProgress) void this.renderLoop();
	}

	private async renderLoop(): Promise<void> {
		this.renderInProgress = true;
		try {
			while (this.deck && (this.urgentRenderKeys.size > 0 || this.renderRequested || this.lcdRenderRequested)) {
				const urgentKey = this.urgentRenderKeys.values().next().value as number | undefined;
				if (urgentKey !== undefined) {
					this.urgentRenderKeys.delete(urgentKey);
					await this.renderKey(this.deck, urgentKey);
					continue;
				}
				if (this.renderRequested) {
					this.renderRequested = false;
					this.lcdRenderRequested = false;
					const completed = await this.renderFrame(this.deck);
					if (!completed) this.renderRequested = true;
					continue;
				}
				this.lcdRenderRequested = false;
				await this.renderLcd(this.deck);
			}
		} catch (error) {
			this.handleDeviceError(error);
		} finally {
			this.renderInProgress = false;
			if (this.deck && (this.urgentRenderKeys.size > 0 || this.renderRequested || this.lcdRenderRequested)) this.ensureRenderLoop();
		}
	}

	private async renderFrame(deck: StreamDeck): Promise<boolean> {
		const svgs = this.page === 0 ? this.mainPage() : this.taskPage(PAGE_AGENT[this.page]!);
		for (let key = 0; key < KEY_COUNT; key += 1) {
			if (this.urgentRenderKeys.size > 0) return false;
			await this.renderKey(deck, key, svgs[key]);
			if (this.urgentRenderKeys.size > 0) return false;
		}
		if (this.urgentRenderKeys.size > 0) return false;
		if (!await this.renderLcd(deck)) return false;
		await this.renderTouchPoints(deck);
		return true;
	}

	private currentInfobarOptions(): InfobarOptions {
		const tasks = [...deviceState.getTasks("codex"), ...deviceState.getTasks("claude")];
		const waiting = tasks.filter(t => t.status === "NEEDS_INPUT" || (t.status === "APPROVAL" && t.request?.humanRequired)).sort((a,b)=>b.lastEventAt-a.lastEventAt)[0];
		const agent = PAGE_AGENT[this.page];
		const terminal = this.page === 0 ? resolveTerminalInfobar(tasks, Date.now()) : undefined;
		this.scheduleTerminalInfobarExpiry(terminal?.expiresAt, Date.now());
		return { recap: terminal?.kind === "recap" ? terminal.recap : undefined, error: terminal?.kind === "error" ? {agent: terminal.agent, detail: terminal.detail} : undefined, offline: deviceState.isOffline(), setup: deviceState.isSetup(), runningCount: deviceState.getStatus()?.runningTaskCount ?? 0,
			waitingInput: waiting?.agent ?? (deviceState.getActivePlanInput() ? "codex" : undefined),
			pageLabel: this.page === 0 ? "OVERVIEW" : `${agent!.toUpperCase()} ${this.page > 0 ? "+" : ""}${this.page}`,
			overflowCount: agent ? deviceState.getOverflowCount(agent) : 0,
		};
	}

	private async renderLcd(deck: StreamDeck): Promise<boolean> {
		const options = this.currentInfobarOptions();
		const layout = layoutInfobar(options);
		const now = Date.now();
		if (layout.contentKey !== this.lcdContentKey) {
			this.lcdContentKey = layout.contentKey;
			this.lcdContentStartedAt = now;
		}
		const overflowPx = Math.max(0, layout.detailWidth - layout.detailViewportWidth);
		this.scheduleLcdAnimation(overflowPx > 0);
		const scrollOffset = infobarMarqueeOffset(overflowPx, now - this.lcdContentStartedAt);
		const bar = renderInfobar(options, { scrollOffset });
		if (this.lastFrame.get("lcd") !== bar) {
			const buffer = await rasterizeSvg(bar, 248, 58);
			if (this.urgentRenderKeys.size > 0) {
				this.lcdRenderRequested = true;
				return false;
			}
			await deck.fillLcd(0, buffer, { format: "rgba" });
			this.lastFrame.set("lcd", bar);
		}
		return true;
	}

	private scheduleLcdAnimation(active: boolean): void {
		if (!active) return this.clearLcdAnimation(false);
		if (this.lcdAnimationTimer || this.stopped || !this.deck) return;
		this.lcdAnimationTimer = setTimeout(() => {
			this.lcdAnimationTimer = undefined;
			if (this.stopped || !this.deck) return;
			this.requestLcdRender();
		}, INFOBAR_MARQUEE_FRAME_MS);
	}

	private clearLcdAnimation(resetContent = true): void {
		if (this.lcdAnimationTimer) clearTimeout(this.lcdAnimationTimer);
		this.lcdAnimationTimer = undefined;
		if (!resetContent) return;
		this.lcdContentKey = undefined;
		this.lcdContentStartedAt = 0;
	}

	private async renderTouchPoints(deck: StreamDeck): Promise<void> {
		const colors = buildTouchPointColors(deviceState, this.page);
		for (const agent of ["codex", "claude"] as const) {
			const key = TOUCH_POINT_KEYS[agent];
			const rgb = colors[agent];
			const cacheKey = `touch:${key}`;
			const value = rgb.join(",");
			if (this.lastFrame.get(cacheKey) === value) continue;
			await deck.fillKeyColor(key, rgb[0], rgb[1], rgb[2]);
			this.lastFrame.set(cacheKey, value);
		}
	}

	private async renderKey(deck: StreamDeck, key: number, suppliedBase?: string): Promise<void> {
		const page = this.page;
		const now = Date.now();
		const feedback = this.feedback?.key === key && this.feedback.expiresAt > now ? this.feedback : undefined;
		const press = this.physicalPresses.get(key);
		const visiblePress = press?.page === page ? press : undefined;
		let preparedBuffer: Promise<Uint8Array | undefined> | undefined;
		let svg: string;
		if (feedback) svg = feedback.success
			? renderSuccessTile(feedback.message, feedback.detail ?? "SENT")
			: renderFailureTile(feedback.message);
		else if (visiblePress) {
			if (visiblePress.firstFrameShownAt === undefined) {
				svg = visiblePress.firstFrameSvg;
				preparedBuffer = visiblePress.firstFrameBuffer;
			} else {
				svg = renderPressedTile(visiblePress.baseSvg, this.pressProgress(visiblePress, now));
			}
		} else {
			svg = suppliedBase ?? this.pageKeySvg(page, key);
		}
		const wrote = await this.writeKey(
			deck,
			key,
			svg,
			visiblePress ? () => this.page === page && this.physicalPresses.get(key) === visiblePress : undefined,
			preparedBuffer,
		);
		if (!wrote || feedback || !visiblePress || this.physicalPresses.get(key) !== visiblePress || visiblePress.firstFrameShownAt !== undefined) return;
		const shownAt = Date.now();
		visiblePress.firstFrameShownAt = shownAt;
		const latency = shownAt - visiblePress.startedAt;
		if (latency > PRESS_FEEDBACK_BUDGET_MS && !visiblePress.slowWarningLogged) {
			visiblePress.slowWarningLogged = true;
			console.warn(`[device] slow press feedback: key=${key} latency=${latency}ms`);
		}
	}

	private pageKeySvg(page: Page, key: number): string {
		const svgs = page === 0 ? this.mainPage() : this.taskPage(PAGE_AGENT[page]!);
		return svgs[key]!;
	}

	private taskPage(agent: AgentKind): string[] {
		if (deviceState.isOffline()) {
			return [renderSystemTile("SUPERVISOR", "OFFLINE"), ...Array.from({ length: 7 }, () => renderEmptySlot(agent))];
		}
		if (deviceState.isSetup()) {
			return [renderSystemTile("SETUP", "REQUIRED", COLORS.approval, "settings"), ...Array.from({ length: 7 }, () => renderEmptySlot(agent))];
		}
		if (deviceState.isAgentDisabled(agent)) {
			return [renderSystemTile(`${agent.toUpperCase()} DISABLED`, "ENABLE IN APP"), ...Array.from({ length: 7 }, () => renderEmptySlot(agent))];
		}

		if (!deviceState.isAgentHealthy(agent) && deviceState.getLiveTasks(agent).length === 0) {
			return [renderSystemTile(`${agent.toUpperCase()} OFFLINE`, "CHECK SOURCE"), ...Array.from({ length: 7 }, () => renderEmptySlot(agent))];
		}
		return Array.from({ length: KEY_COUNT }, (_, slot) => {
			const item = deviceState.getDisplayTask(agent, (Math.abs(this.page)-1)*4 + slot%4);
			return item.task ? renderTaskColumnKey(item.task, slot >= 4, deviceState.getSlot(item.task)?.durationMs) : renderEmptySlot(agent);
		});
	}

	private mainPage(): string[] {
		const models = buildMainTileModels(deviceState, deviceState.isOffline() || deviceState.isSetup());
		const rendered = models.map(model => renderMainTile(model));
		if (deviceState.isOffline()) rendered[0] = renderSystemTile("SUPERVISOR", "OFFLINE");
		else if (deviceState.isSetup()) rendered[0] = renderSystemTile("SETUP", "REQUIRED", COLORS.approval, "settings");
		return rendered;
	}

	private async writeKey(deck: StreamDeck, key: number, svg: string, isCurrent?: () => boolean, preparedBuffer?: Promise<Uint8Array | undefined>): Promise<boolean> {
		if (this.lastFrame.get(`key:${key}`) === svg) return false;
		const buffer = await preparedBuffer ?? await rasterizeSvg(svg, 96, 96);
		if (isCurrent && !isCurrent()) return false;
		await deck.fillKeyBuffer(key, buffer, { format: "rgba" });
		this.lastFrame.set(`key:${key}`, svg);
		return true;
	}
}

/** Pure view-model builder used by the controller and interaction/visual regression tests. */
export function buildMainTileModels(state: DeviceState, forceQuiet = false): MainTileModel[] {
	const active = forceQuiet ? null : state.getActiveAgent() ?? state.getFocus().activeAgent;
	const task = [...state.getTasks("codex"), ...state.getTasks("claude")].filter(t => t.status === "RUNNING" && state.isAgentHealthy(t.agent)).sort((a,b)=>(b.progress.latestActivity?.at ?? 0)-(a.progress.latestActivity?.at ?? 0))[0];
	const liveProgress = !!task && isLiveTask(task);
	const processAccent = task?.agent === "claude" ? COLORS.claude : COLORS.codex;
	const liveTasks = forceQuiet ? [] : [...state.getLiveTasks("codex"), ...state.getLiveTasks("claude")].filter(t => t.status === "RUNNING" && state.isAgentHealthy(t.agent));
	const aggregate = liveTasks.reduce((value, liveTask) => {
		const total = safeProgressCount(liveTask.progress.todoTotal);
		const completed = Math.min(total, safeProgressCount(liveTask.progress.todoCompleted));
		return { completed: value.completed + completed, total: value.total + total };
	}, { completed: 0, total: 0 });
	const estimatedRemainingMs = estimateRemainingWork(state, liveTasks);
	const activityValue = task?.progress.latestActivity?.label ?? (task ? "Working" : "Idle");
	const activityFooter = !liveProgress && task ? terminalActivityFooter(task.status) : undefined;
	const codex = state.getAgentSummary("codex");
	const claude = state.getAgentSummary("claude");
	const codexEffort = reasoningLabel(state.getReasoningEffort("codex"));
	const claudeEffort = reasoningLabel(state.getReasoningEffort("claude"));
	const codexEffortActive = !forceQuiet && state.hasRunningReasoningTask("codex");
	const claudeEffortActive = !forceQuiet && state.hasRunningReasoningTask("claude");
	const newChatAgent = state.getNewChatAgent();
	const hasRunningAgent = codex.runningCount > 0 || claude.runningCount > 0;
	const actionEmphasis = (actionable: boolean): "quiet" | "active" => !forceQuiet && actionable ? "active" : "quiet";
	const agentEmphasis = (summary: ReturnType<DeviceState["getAgentSummary"]>): "quiet" | "active" | "attention" | "done" | "error" => {
		if (forceQuiet) return "quiet";
		if (summary.visualState === "attention") return "attention";
		if (summary.visualState === "running") return "active";
		return summary.visualState;
	};

	return [
		{ label: codexEffortActive ? codexEffort : "REASONING", detail: codexEffortActive ? modelLabel(state.getSelectedTask("codex")?.model) : undefined, accent: COLORS.codex, actionable: codexEffortActive, emphasis: actionEmphasis(codexEffortActive), icon: "circle-gauge" },
		{ label: "CODEX", detail: codex.planReady ? "PLAN" : codex.needsInput ? "QUESTION" : codex.terminalReminder, accent: COLORS.codex, actionable: !forceQuiet, emphasis: agentEmphasis(codex), agent: "codex", badge: codex.planReady || codex.needsInput ? "?" : codex.decisionCount ? String(codex.decisionCount) : undefined },
		{ label: "CLAUDE", detail: claude.terminalReminder, accent: COLORS.claude, actionable: !forceQuiet, emphasis: agentEmphasis(claude), agent: "claude", badge: claude.decisionCount ? String(claude.decisionCount) : undefined },
		{ label: claudeEffortActive ? claudeEffort : "REASONING", detail: claudeEffortActive ? modelLabel(state.getSelectedTask("claude")?.model) : undefined, accent: COLORS.claude, actionable: claudeEffortActive, emphasis: actionEmphasis(claudeEffortActive), icon: "circle-gauge" },
		{ label: "NEW CHAT", accent: COLORS[newChatAgent], actionable: !forceQuiet, emphasis: actionEmphasis(hasRunningAgent), icon: "message-square-plus" },
		{
			label: "ACTIVITY",
			detail: activityValue,
			accent: processAccent,
			actionable: false,
			emphasis: !forceQuiet && liveProgress ? "active" : "quiet",
			mutedDetail: !forceQuiet && !!task && !liveProgress,
			icon: "activity",
			process: { kind: "activity", value: activityValue, ...(activityFooter ? { footer: activityFooter } : {}) },
		},
		{
			label: "PROGRESS",
			detail: aggregate.total > 0 ? `${aggregate.completed} / ${aggregate.total}` : "—",
			accent: processAccent,
			actionable: false,
			emphasis: !forceQuiet && liveTasks.length > 0 ? "active" : "quiet",
			icon: "chart-no-axes-column-increasing",
			process: {
				kind: "progress",
				completed: aggregate.completed,
				total: aggregate.total,
				liveTaskCount: liveTasks.length,
				unknownCount: liveTasks.filter(t => safeProgressCount(t.progress.todoTotal) === 0).length,
				...(estimatedRemainingMs !== undefined ? { estimatedRemainingMs } : {}),
			},
		},
		{
			label: "TODAY",
			detail: `${formatDuration(state.getStatus()?.monitor?.days[localDateKey()]?.[state.getStatus()?.monitor?.selectedAgent ?? state.getNewChatAgent()] ?? 0)}`,
			accent: COLORS[state.getStatus()?.monitor?.selectedAgent ?? state.getNewChatAgent()], actionable: false,
			emphasis: forceQuiet ? "quiet" : "active", icon: "clock",
		},
	];
}

export type TouchPointRgb = readonly [number, number, number];

/** Page 0 is always reachable; sparse task pages are skipped in either direction. */
export function nextContentPage(state: DeviceState, page: Page, direction: -1 | 1): Page | undefined {
	for (let next = page + direction; next >= -3 && next <= 3; next += direction) {
		if (next === 0) return 0;
		if (state.isOffline() || state.isSetup()) continue;
		const agent = PAGE_AGENT[next as Page]!;
		const start = (Math.abs(next) - 1) * 4;
		if (Array.from({ length: 4 }, (_, index) => state.getDisplayTask(agent, start + index).task).some(Boolean)) return next as Page;
	}
	return undefined;
}

export function buildTouchPointColors(state: DeviceState, page: Page = 0): Record<AgentKind, TouchPointRgb> {
	const color = (direction: -1 | 1): TouchPointRgb => {
		const next = nextContentPage(state, page, direction);
		if (next === undefined) return [0, 0, 0];
		if (next === 0) return [180, 190, 208];
		return next < 0 ? [122, 157, 255] : [217, 119, 87];
	};
	return { codex: color(-1), claude: color(1) };
}

function modelLabel(model: string | undefined): string {
	return model?.replace(/^claude-/i, "").replace(/-20\d{6}$/, "").toUpperCase() ?? "MODEL —";
}

/** Rough equal-step extrapolation. Parallel tasks finish when the slowest estimate finishes.
 * No estimate for missing plans, insufficient samples, or a plan already exhausted while still running.
 * Observed execution time excludes approvals, sleep and downtime when monitor slots are available.
 */
export function estimateRemainingWork(state: DeviceState, tasks: readonly Task[]): number | undefined {
	if (tasks.length === 0) return undefined;
	let remaining = 0;
	for (const task of tasks) {
		const total = safeProgressCount(task.progress.todoTotal);
		const completed = Math.min(total, safeProgressCount(task.progress.todoCompleted));
		const elapsed = state.getSlot(task)?.durationMs ?? task.progress.durationMs;
		if (task.status !== "RUNNING" || completed < 2 || completed >= total || !Number.isFinite(elapsed) || elapsed < 30_000) return undefined;
		remaining = Math.max(remaining, elapsed / completed * (total - completed));
	}
	return remaining;
}

function reasoningLabel(value: Task["reasoningEffort"]): string {
	return value?.toUpperCase() ?? "—";
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1_000));
	if (seconds < 60) return `${seconds}S`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}M${seconds % 60}S` : `${Math.floor(minutes / 60)}H${minutes % 60}M`;
}

/** Live Turns use wall time; terminal Turns keep their final reduced duration. */
function taskDurationMs(task: Task, now = Date.now()): number {
	if (isLiveTask(task) && task.progress.turnStartedAt) return Math.max(0, now - task.progress.turnStartedAt);
	return Math.max(0, task.progress.durationMs ?? 0);
}

function safeProgressCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compactTaskCount(value: number): string {
	return value > 99 ? "99+" : String(Math.max(0, value));
}

function terminalActivityFooter(status: Task["status"]): string {
	switch (status) {
		case "DONE":
		case "DONE_UNREAD": return "DONE";
		case "ERROR": return "ERROR";
		case "PAUSED": return "PAUSED";
		case "QUEUED": return "QUEUED";
		case "STALE": return "STALE";
		case "IDLE": return "IDLE";
		default: return "";
	}
}

function activityDisplayValue(task: Task | undefined): string {
	if (!task) return "QUIET";
	if (task.status === "APPROVAL" || task.status === "NEEDS_INPUT") return "WAITING";
	if (!isLiveTask(task)) {
		switch (task.status) {
			case "DONE":
			case "DONE_UNREAD": return "COMPLETED";
			case "ERROR": return "FAILED";
			case "PAUSED": return "PAUSED";
			case "QUEUED": return "QUEUED";
			case "STALE": return "STALE";
			case "IDLE": return "IDLE";
		}
	}

	const activity = task.progress.latestActivity;
	if (!activity) return "WORKING";
	if (activity.state === "waiting") return "WAITING";
	if (activity.state === "error") return "FAILED";
	const label = activity.label.toLowerCase();
	switch (activity.category) {
		case "thinking": return "THINKING";
		case "shell":
			if (/\b(?:test|tests|testing|verify|verifying|verification|check|checks|checking|lint|regression)\b|\u6d4b\u8bd5|\u9a8c\u8bc1|\u68c0\u67e5/u.test(label)) return "TESTING";
			if (/\b(?:build|building|compile|compiling|package|packaging|bundle|assemble)\b|\u6784\u5efa|\u7f16\u8bd1|\u6253\u5305/u.test(label)) return "BUILDING";
			if (/\b(?:install|installing|download|downloading|fetch|fetching)\b|\u5b89\u88c5|\u4e0b\u8f7d/u.test(label)) return "INSTALLING";
			return "RUNNING";
		case "file":
			if (/\b(?:read|reading|inspect|inspecting|open|opening)\b|\u8bfb\u53d6|\u67e5\u770b/u.test(label)) return "READING";
			return "WRITING";
		case "search": return "SEARCHING";
		case "browser": return "BROWSING";
		case "plan": return "PLANNING";
		case "agent": return "DELEGATING";
		case "input": return "WAITING";
		case "terminal": return "FINALIZING";
		default: return "WORKING";
	}
}

function localDateKey(): string { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
