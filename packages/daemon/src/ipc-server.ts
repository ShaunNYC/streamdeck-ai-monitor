import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
	createEnvelope,
	decodeEnvelope,
	encodeEnvelope,
	type AckPayload,
	type AgentActionPayload,
	type DismissCompletedDeviceTasksPayload,
	type ErrorPayload,
	type IpcEnvelope,
	type PlanAnswerActionPayload,
	type PendingPlanInput,
	type SystemSnapshotPayload,
	type TaskActionPayload,
	LocalSocket,
} from "@streamdeck-supervisor/shared";
import type { AgentKind, AppServerStatus, DesktopIntegrationStatus, DeviceConnectionStatus, ReasoningEffort, SystemStatus, Task } from "@streamdeck-supervisor/shared";
import type { CodexModelDescriptor, CreateManagedTaskRequest, ManagedTaskDetail } from "@streamdeck-supervisor/shared";
import type { AdapterStatus } from "@streamdeck-supervisor/shared";
import { ADAPTER_MODE, CODEX_PLAN_RELAY_ENABLED, HEARTBEAT_INTERVAL_MS, IPC_HOST, IPC_PORT, createSessionToken, getDataDirectory, getTokenPath } from "./config.js";
import { ClaudeHookAdapter, claudeHookEnvironment } from "./adapters/claude-hook-adapter.js";
import { readClaudeDefaultReasoningEffort } from "./adapters/claude-transcript.js";
import { CodexCatalogAdapter, readCodexDefaultReasoningEffort } from "./adapters/codex-catalog-adapter.js";
import { MockAdapter, createMockTasks } from "./mock-adapter.js";
import { TaskRegistry } from "./task-registry.js";
import { TaskActionService } from "./task-action-service.js";
import { MonitorStore } from "./monitor-store.js";
import { RegistryStore } from "./registry-store.js";
import { enrichTaskWithProject, loadSupervisorConfig, type SupervisorConfig } from "./supervisor-config.js";
import path from "node:path";
import { AuditLogger } from "./audit-log.js";
import { CodexAppServerBridge } from "./codex-app-server-bridge.js";
import { createDefaultCodexApprovalControl, type CodexApprovalControl } from "./codex-approval-control.js";
import { CodexManagedController } from "./codex-managed-controller.js";

type AuthenticatedClient = { socket: WebSocket; name: string };

const DEVICE_ACTIONS = new Set([
	"action.selectTask", "action.focusAgent", "action.openAgent", "action.activateAgentApp",
	"action.newChat", "action.newCodexChat", "action.open", "action.review", "action.verify",
	"action.answerPlanQuestion",
	"action.dismissDeviceTask",
	"action.dismissCompletedDeviceTasks",
]);

export interface IpcServerOptions {
	port?: number;
	adapterMode?: "real" | "mock";
	config?: SupervisorConfig;
	codexPlanRelayEnabled?: boolean;
	/** Sandboxed distribution observes logs without spawning or controlling other agents. */
	observerOnly?: boolean;
	codexApprovalControl?: CodexApprovalControl;
	getDeviceConnection?: () => DeviceConnectionStatus;
	getLoginItemEnabled?: () => boolean | undefined;
	getDesktopIntegration?: () => DesktopIntegrationStatus | undefined;
	onNewChatRequested?: (agent: AgentKind) => void;
}

function actionPayload(value: unknown): TaskActionPayload | null {
	if (!value || typeof value !== "object") return null;
	const payload = value as Record<string, unknown>;
	if ((payload.agent !== "codex" && payload.agent !== "claude") || typeof payload.taskId !== "string") return null;
	return {
		agent: payload.agent,
		taskId: payload.taskId,
		...(typeof payload.executionId === "string" ? { executionId: payload.executionId } : {}),
	};
}

function agentActionPayload(value: unknown): AgentActionPayload | null {
	if (!value || typeof value !== "object") return null;
	const agent = (value as Record<string, unknown>).agent;
	return agent === "codex" || agent === "claude" ? { agent } : null;
}

function planAnswerPayload(value: unknown): PlanAnswerActionPayload | null {
	if (!value || typeof value !== "object") return null;
	const payload = value as Record<string, unknown>;
	if (payload.agent !== "codex" || typeof payload.taskId !== "string" || typeof payload.requestId !== "string" || typeof payload.questionId !== "string" || typeof payload.optionIndex !== "number" || !Number.isInteger(payload.optionIndex)) return null;
	return {
		agent: "codex",
		taskId: payload.taskId,
		requestId: payload.requestId,
		questionId: payload.questionId,
		optionIndex: payload.optionIndex,
	};
}

function planPriority(status: import("@streamdeck-supervisor/shared").Task["status"] | undefined): number {
	return status === "APPROVAL" ? 0 : status === "NEEDS_INPUT" ? 1 : status === "ERROR" ? 2 : status === "DONE_UNREAD" ? 3 : status === "RUNNING" ? 4 : 99;
}

function isPendingTerminal(task: Task, now: number): boolean {
	const version = task.attentionVersion ?? (task.attentionCount > 0 ? 1 : 0);
	const acknowledged = task.acknowledgedAttentionVersion ?? 0;
	return version > acknowledged && task.attentionExpiresAt !== undefined && task.attentionExpiresAt > now;
}

export class IpcServer {
	private readonly taskRegistry: TaskRegistry;
	private readonly config: SupervisorConfig;
	private readonly registryStore: RegistryStore;
	private readonly monitor: MonitorStore;
	private suspended = false;
	private monitorTimer?: ReturnType<typeof setInterval>;
	private readonly taskActions: TaskActionService;
	private readonly audit = new AuditLogger();
	private readonly mock?: MockAdapter;
	private readonly token: string;
	private readonly startedAt = Date.now();
	private readonly clients = new Set<AuthenticatedClient>();
	private readonly authenticatedSockets = new WeakSet<WebSocket>();
	private readonly server?: WebSocketServer;
	private readonly observerOnly: boolean;
	private readonly port: number;
	private readonly adapterMode: "real" | "mock";
	private readonly planInputs = new Map<string, PendingPlanInput>();
	private readonly codexBridge?: CodexAppServerBridge;
	private readonly managedCodex?: CodexManagedController;
	private readonly codexApprovalControl: CodexApprovalControl;
	private readonly getDeviceConnection: () => DeviceConnectionStatus;
	private readonly getLoginItemEnabled: () => boolean | undefined;
	private readonly getDesktopIntegration: () => DesktopIntegrationStatus | undefined;
	private readonly onNewChatRequested?: (agent: AgentKind) => void;
	private readonly submittedCodexRequests = new Map<string, string>();
	private appServerStatus: AppServerStatus;
	private readonly adapterStatuses: Record<"claude" | "codex" | "workflow", AdapterStatus> = {
		claude: { status: "OFFLINE", lastPollAt: 0 },
		codex: { status: "OFFLINE", lastPollAt: 0 },
		workflow: { status: "OK", lastPollAt: Date.now() },
	};
	private claudeAdapter: ClaudeHookAdapter | undefined;
	private codexAdapter: CodexCatalogAdapter | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(portOrOptions: number | IpcServerOptions = IPC_PORT) {
		const options: IpcServerOptions = typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
		this.port = options.port ?? IPC_PORT;
		this.observerOnly = options.observerOnly === true;
		this.adapterMode = options.adapterMode ?? ADAPTER_MODE;
		this.codexApprovalControl = options.codexApprovalControl ?? createDefaultCodexApprovalControl();
		this.getDeviceConnection = options.getDeviceConnection ?? (() => ({ state: "STOPPED", devices: [] }));
		this.getLoginItemEnabled = options.getLoginItemEnabled ?? (() => undefined);
		this.getDesktopIntegration = options.getDesktopIntegration ?? (() => undefined);
		this.onNewChatRequested = options.onNewChatRequested;
		this.appServerStatus = { status: this.adapterMode === "mock" ? "OK" : "OFFLINE", lastPollAt: 0 };
		this.token = createSessionToken();
		this.config = options.config ?? loadSupervisorConfig();
		this.adapterStatuses.codex = { status: this.adapterMode === "mock" ? "OK" : this.config.agents.codex.enabled ? "OFFLINE" : "DISABLED", lastPollAt: 0 };
		this.adapterStatuses.claude = { status: this.adapterMode === "mock" ? "OK" : this.config.agents.claude.enabled ? "OFFLINE" : "DISABLED", lastPollAt: 0 };
		this.monitor = new MonitorStore(this.adapterMode === "real" ? path.join(getDataDirectory(), "monitor.json") : undefined);
		this.registryStore = new RegistryStore(path.join(getDataDirectory(), "state.json"));
		const persisted = this.adapterMode === "real" ? this.registryStore.load() : null;
		const persistedTasks = (persisted?.tasks ?? [])
			.filter((task) => this.config.agents[task.agent].enabled)
			.map(preparePersistedTask);
		this.taskRegistry = new TaskRegistry(
			this.adapterMode === "mock" ? createMockTasks() : persistedTasks,
			persisted?.focus,
			persisted?.terminalAcknowledgements,
			persisted?.observationBaselineAt,
			persisted?.clearedExecutions,
		);
		for (const agent of ["codex", "claude"] as const) {
			this.taskRegistry.dismissExecutions(agent, this.monitor.getDismissedExecutions());
		}
		if (this.adapterMode === "real" && this.config.agents.codex.enabled && !options.observerOnly) {
			this.managedCodex = new CodexManagedController({
				registry: this.taskRegistry,
				filePath: path.join(getDataDirectory(), "managed-codex.json"),
				onPlanInput: (input) => this.handlePlanInput(input),
				onPlanInputCleared: (requestId) => this.handlePlanInputCleared(requestId),
				onStatus: (status) => {
					this.appServerStatus = status;
					this.broadcastStatus();
					this.broadcastSnapshot();
				},
			});
		}
		const planRelayEnabled = options.codexPlanRelayEnabled ?? CODEX_PLAN_RELAY_ENABLED;
		if (this.adapterMode === "real" && this.config.agents.codex.enabled && !options.observerOnly) {
			this.codexBridge = new CodexAppServerBridge({
				getThreadIds: () => this.taskRegistry.getTasksForAgent("codex")
					.filter((task) => task.status === "RUNNING" || task.status === "NEEDS_INPUT")
					.map((task) => task.externalId),
				onInput: (input) => this.handlePlanInput(input),
				onCleared: (requestId) => this.handlePlanInputCleared(requestId),
					onStatus: (status) => {
					if (!this.managedCodex || this.managedCodex.getStatus().status === "OFFLINE") this.appServerStatus = status;
					this.broadcastStatus();
					this.broadcastSnapshot();
				},
				planRelayEnabled,
			});
		}
		this.taskActions = new TaskActionService(this.taskRegistry, this.audit, undefined, {
			interruptCodex: this.codexBridge ? (threadId, turnId) => this.codexBridge!.interrupt(threadId, turnId) : undefined,
		});
		if (this.adapterMode === "mock") {
			this.mock = new MockAdapter(this.taskRegistry);
		} else {
			if (this.config.agents.claude.enabled) this.claudeAdapter = new ClaudeHookAdapter(this.adapterContext(), this.token, this.config.agents.claude.transcriptDirectory, "observe", this.config.agents.claude.desktopSessionDirectory, !this.observerOnly);
			if (this.config.agents.codex.enabled) {
				this.codexAdapter = new CodexCatalogAdapter(
					this.adapterContext(),
					this.config.agents.codex.stateDirectory,
					() => this.codexApprovalControl.getStatus().status === "READY",
					() => this.codexBridge?.getStatus().status === "OK",
					(threadId) => this.managedCodex?.isManagedThread(threadId) === true,
				);
			}
		}
		if (!this.observerOnly) {
			this.server = new WebSocketServer({ host: IPC_HOST, port: this.port });
			this.server.on("connection", (socket) => this.handleConnection(socket));
			this.server.on("error", (error) => console.error(`[daemon] WebSocket server error: ${error.message}`));
		}
		this.taskRegistry.onChange(() => {
			if (this.adapterMode === "real") this.registryStore.schedule({ version: 8, ...this.taskRegistry.getPersistedState(), savedAt: Date.now() });
			this.broadcastSnapshot();
			void this.codexBridge?.syncThreads();
		});
		if (this.adapterMode === "real") this.registryStore.schedule({ version: 8, ...this.taskRegistry.getPersistedState(), savedAt: Date.now() });
	}

	get registry() {
		return this.taskRegistry;
	}

	get tokenPath(): string {
		return getTokenPath();
	}

	connectInProcess(): LocalSocket {
		if (!this.observerOnly) throw new Error("In-process IPC is only available in observer mode");
		const [server, client] = LocalSocket.pair();
		this.handleConnection(server as unknown as WebSocket);
		return client;
	}

	getTasks(): Task[] { return this.taskRegistry.getTasks().map((task) => structuredClone(task)); }
	getManagedDetails(): ManagedTaskDetail[] { return this.managedCodex?.getDetails() ?? []; }
	getManagedDetail(taskId: string): ManagedTaskDetail | undefined { return this.managedCodex?.getDetail(taskId); }
	async openDesktopAgent(agent: AgentKind, newChat = false): Promise<void> {
		if (newChat) await this.taskActions.newChat(agent);
		else await this.taskActions.openAgent(agent);
	}
	async openDesktopTask(taskId: string): Promise<void> {
		const task = this.taskRegistry.getTask(taskId);
		if (!task || !task.capabilities.desktop.open || !task.openRef.value) throw new Error("Task has no open target");
		await this.taskActions.runReadAction("open", task);
	}

	async listCodexModels(): Promise<CodexModelDescriptor[]> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		return this.managedCodex.listModels();
	}

	async createManagedTask(request: CreateManagedTaskRequest): Promise<ManagedTaskDetail> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		return this.managedCodex.createTask(request);
	}

	async sendManagedMessage(taskId: string, text: string): Promise<ManagedTaskDetail> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		return this.managedCodex.sendMessage(taskId, text);
	}

	async retryManagedMessage(taskId: string, messageId: string): Promise<ManagedTaskDetail> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		return this.managedCodex.retryMessage(taskId, messageId);
	}

	async updateManagedSettings(taskId: string, settings: { model?: string; effort?: ReasoningEffort }): Promise<void> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		await this.managedCodex.updateSettings(taskId, settings);
	}

	async interruptDesktopTask(taskId: string): Promise<void> {
		const task = this.taskRegistry.getTask(taskId);
		if (!task?.executionId || !task.capabilities.desktop.interrupt) throw new Error("Task is no longer interruptible");
		if (task.ownership === "managed") {
			if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
			await this.managedCodex.interrupt(taskId);
			return;
		}
		if (!await this.taskActions.stop(task, task.executionId)) throw new Error("Task could not be interrupted");
	}

	async decideDesktopRequest(taskId: string, requestId: string, decision: "approve" | "reject"): Promise<void> {
		const task = this.taskRegistry.getTask(taskId);
		if (!task?.request || task.request.requestId !== requestId || task.status !== "APPROVAL") throw new Error("Approval request is stale");
		if (task.ownership === "managed") {
			if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
			await this.managedCodex.resolveRequest(taskId, requestId, { decision: decision === "approve" ? "accept" : "decline" });
			return;
		}
		if (decision === "approve" ? !task.capabilities.desktop.approve : !task.capabilities.desktop.reject) throw new Error("Task does not expose this decision");
		if (task.agent === "claude") {
			if (task.request.decisionPath !== "claude-hook" || !this.claudeAdapter?.hasPendingDecision(taskId, requestId)
				|| !this.claudeAdapter.decide(task, requestId, decision === "approve" ? "allow" : "deny")) throw new Error("Claude request is no longer active");
			return;
		}
		if (task.request.decisionPath !== "codex-shortcut" || !this.isCurrentCodexApproval(taskId, requestId)) throw new Error("Codex request is no longer active");
		await this.codexApprovalControl.submit(task, decision, () => this.isCurrentCodexApproval(taskId, requestId));
		if (this.isCurrentCodexApproval(taskId, requestId)) {
			this.submittedCodexRequests.set(requestId, taskId);
			this.taskRegistry.markApprovalSubmitted(taskId, requestId);
		}
	}

	async answerManagedRequest(taskId: string, requestId: string, answers: Record<string, string[]>): Promise<void> {
		if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
		await this.managedCodex.resolveRequest(taskId, requestId, { answers });
	}

	setSuspended(value: boolean): void { this.suspended = value; this.monitor.resetClock(); }

	get status(): SystemStatus {
		const reasoningDefaults = this.reasoningDefaults();
		const loginItemEnabled = this.getLoginItemEnabled();
		const desktopIntegration = this.getDesktopIntegration();
		const now = Date.now();
		const agentRuntime = Object.fromEntries((["codex", "claude"] as const).map((agent) => {
			const tasks = this.taskRegistry.getTasksForAgent(agent);
			const terminal = tasks.filter((task) => (task.status === "DONE_UNREAD" || task.status === "ERROR") && isPendingTerminal(task, now));
			const latest = terminal.sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
			return [agent, {
				runningCount: tasks.filter((task) => task.status === "RUNNING").length,
				decisionCount: tasks.filter((task) => task.status === "APPROVAL" || task.status === "NEEDS_INPUT").length,
				...(latest ? { terminalReminder: { status: latest.status === "ERROR" ? "ERROR" as const : "DONE" as const, count: terminal.length, expiresAt: latest.attentionExpiresAt! } } : {}),
			}];
		})) as SystemStatus["agentRuntime"];
		return {
			monitor: this.monitor.update(this.taskRegistry.getTasks(), { codex: !this.suspended && this.adapterStatuses.codex.status === "OK", claude: !this.suspended && this.adapterStatuses.claude.status === "OK" }),
			daemonUptimeMs: Date.now() - this.startedAt,
			daemonPid: process.pid,
			adapters: { ...this.adapterStatuses },
			codexAppServer: this.appServerStatus,
			codexApprovalControl: this.codexApprovalControl.getStatus(),
			configuredProjectCount: this.mock?.configuredProjectCount ?? this.config.projects.length,
			monitoringScope: "all-projects",
			deviceConnection: this.getDeviceConnection(),
			...(loginItemEnabled !== undefined ? { loginItemEnabled } : {}),
			...(desktopIntegration ? { desktopIntegration } : {}),
			runningTaskCount: this.taskRegistry.getTasks().filter((task) => task.status === "RUNNING").length,
			agentRuntime,
			...(Object.keys(reasoningDefaults).length > 0 ? { reasoningDefaults } : {}),
		};
	}

	private reasoningDefaults(): Partial<Record<AgentKind, ReasoningEffort>> {
		if (this.adapterMode === "mock") return { codex: "high", claude: "high" };
		const codex = readCodexDefaultReasoningEffort(this.config.agents.codex.stateDirectory);
		const transcriptDirectory = this.config.agents.claude.transcriptDirectory;
		const claudeSettings = transcriptDirectory ? path.join(path.dirname(transcriptDirectory), "settings.json") : undefined;
		const claude = readClaudeDefaultReasoningEffort(claudeSettings);
		return { ...(codex ? { codex } : {}), ...(claude ? { claude } : {}) };
	}

	async start(): Promise<void> {
		const server = this.server;
		if (server) await new Promise<void>((resolve, reject) => {
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			server.once("listening", onListening);
			server.once("error", onError);
		});
		this.monitorTimer = setInterval(() => this.broadcastStatus(), 1_000);
		this.heartbeatTimer = setInterval(() => this.broadcastStatus(), HEARTBEAT_INTERVAL_MS);
		this.sweepTimer = setInterval(() => this.taskRegistry.sweep(), 30_000);
		if (this.server) console.log(`[daemon] listening on ws://${IPC_HOST}:${this.port}`);
		console.log(`[daemon] token: ${this.tokenPath}`);
		if (this.adapterMode === "real") {
			await Promise.all([this.claudeAdapter?.start(), this.codexAdapter?.start()]);
			await this.codexBridge?.start();
			await this.managedCodex?.restoreIfNeeded();
			console.log(`[daemon] real adapters enabled (Claude hooks ${this.observerOnly ? "disabled" : `${claudeHookEnvironment("blocking").mode} mode`}; Codex JSONL read-only)`);
		}
	}

	async stop(): Promise<void> {
		if (this.monitorTimer) clearInterval(this.monitorTimer);
		void this.status;
		this.monitor.flush();
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		await this.codexBridge?.stop();
		await this.managedCodex?.stop();
		await Promise.all([this.claudeAdapter?.stop(), this.codexAdapter?.stop()]);
		if (this.adapterMode === "real") this.registryStore.flush({ version: 8, ...this.taskRegistry.getPersistedState(), savedAt: Date.now() });
		for (const client of this.clients) client.socket.close(1000, "daemon stopping");
		if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
	}

	private handleConnection(socket: WebSocket): void {
		let client: AuthenticatedClient | undefined;
		socket.on("message", async (raw) => {
			const envelope = decodeEnvelope(this.rawText(raw));
			if (!envelope) {
				this.sendError(socket, "internal-error", "Malformed IPC envelope");
				return;
			}

			if (!client) {
				if (envelope.type !== "client.hello" || envelope.token !== this.token) {
					socket.close(1008, "invalid token");
					return;
				}
				const hello = envelope.payload as { client?: string; protocolVersion?: number };
				if (hello.client !== "direct-hid-device" || hello.protocolVersion !== 4) {
					socket.close(1008, "unsupported client");
					return;
				}
				client = { socket, name: "direct-hid-device" };
				this.clients.add(client);
				this.authenticatedSockets.add(socket);
				this.sendSnapshot(socket);
				return;
			}

			if (!this.authenticatedSockets.has(socket)) return;
			try {
				await this.handleAuthenticatedMessage(socket, envelope);
			} catch (error) {
				this.sendError(socket, "internal-error", error instanceof Error ? error.message : String(error), envelope.requestId);
			}
		});
		socket.on("close", () => {
			if (client) this.clients.delete(client);
		});
		socket.on("error", () => {
			if (client) this.clients.delete(client);
		});
	}

	private async handleAuthenticatedMessage(socket: WebSocket, envelope: IpcEnvelope): Promise<void> {
		if (envelope.type === "client.hello") return;
		if (!envelope.type.startsWith("action.")) {
			this.failAction(socket, envelope, "unauthorized", "Only action messages are accepted from the plugin");
			return;
		}
		if (!DEVICE_ACTIONS.has(envelope.type)) {
			this.failAction(socket, envelope, "unauthorized", "This action is not available to the device client");
			return;
		}
		if (envelope.token !== this.token) {
			this.failAction(socket, envelope, "invalid-token", "Token is missing or expired");
			return;
		}

		const payload = actionPayload(envelope.payload);
		const agentPayload = agentActionPayload(envelope.payload);
		const planPayload = envelope.type === "action.answerPlanQuestion" ? planAnswerPayload(envelope.payload) : null;
		const completedPayload = envelope.type === "action.dismissCompletedDeviceTasks" ? completedTasksPayload(envelope.payload) : null;
		const agentOnlyAction = envelope.type === "action.focusAgent" || envelope.type === "action.openAgent"
			|| envelope.type === "action.activateAgentApp" || envelope.type === "action.newChat"
			|| envelope.type === "action.newCodexChat";
		if ((agentOnlyAction && !agentPayload)
			|| (envelope.type === "action.dismissCompletedDeviceTasks" && !completedPayload)
			|| (!agentOnlyAction && envelope.type !== "action.answerPlanQuestion" && envelope.type !== "action.dismissCompletedDeviceTasks" && !payload)) {
			this.failAction(socket, envelope, "internal-error", "Invalid action payload");
			return;
		}

		switch (envelope.type) {
			case "action.dismissCompletedDeviceTasks": {
				if (!completedPayload || !this.matchEnvelopeAgent(envelope, completedPayload.agent)
					|| completedPayload.executions.some(item => {
						const task = this.taskRegistry.getTask(item.taskId);
						return task && task.agent !== completedPayload.agent;
					})) return this.failAction(socket, envelope, "unauthorized", "Agent/task binding mismatch");
				this.taskRegistry.dismissExecutions(completedPayload.agent, completedPayload.executions);
				this.broadcastSnapshot();
				break;
			}
			case "action.dismissDeviceTask": {
				if (!payload || !this.matchAgent(envelope, payload)) return this.failAction(socket, envelope, "unauthorized", "Agent/task binding mismatch");
				const task = this.taskRegistry.getTask(payload.taskId);
				if (!task || !payload.executionId || !this.monitor.dismiss(task, payload.executionId)) return this.failAction(socket, envelope, "stale-request", "Only the exact stopped execution can be dismissed");
				this.taskRegistry.dismissExecutions(payload.agent, [{ taskId: task.taskId, executionId: payload.executionId }]);
				this.broadcastSnapshot();
				break;
			}
			case "action.selectTask":
				if (!payload || !this.matchAgent(envelope, payload)) return this.failAction(socket, envelope, "unauthorized", "Agent/task binding mismatch");
				if (!this.taskRegistry.selectTask(payload.agent, payload.taskId)) return this.failAction(socket, envelope, "not-found", "Task no longer exists");
				break;
			case "action.focusAgent": {
				if (!agentPayload || !this.matchEnvelopeAgent(envelope, agentPayload.agent)) return this.failAction(socket, envelope, "unauthorized", "Agent binding mismatch");
				if (!this.taskRegistry.focusAgent(agentPayload.agent)) return this.failAction(socket, envelope, "not-found", "Agent has no active or pending task");
				break;
			}
			case "action.openAgent": {
				if (!agentPayload || !this.matchEnvelopeAgent(envelope, agentPayload.agent)) return this.failAction(socket, envelope, "unauthorized", "Agent binding mismatch");
				await this.taskActions.openAgent(agentPayload.agent);
				break;
			}
			case "action.activateAgentApp": {
				if (!agentPayload || !this.matchEnvelopeAgent(envelope, agentPayload.agent)) return this.failAction(socket, envelope, "unauthorized", "Agent binding mismatch");
				await this.taskActions.activateAgentApp(agentPayload.agent);
				break;
			}
			case "action.newCodexChat": {
				if (!agentPayload || agentPayload.agent !== "codex" || !this.matchEnvelopeAgent(envelope, "codex")) return this.failAction(socket, envelope, "unauthorized", "New chat is Codex-only");
				await this.taskActions.newCodexChat();
				break;
			}
			case "action.newChat": {
				if (!agentPayload || !this.matchEnvelopeAgent(envelope, agentPayload.agent)) return this.failAction(socket, envelope, "unauthorized", "Agent binding mismatch");
				if (this.onNewChatRequested) this.onNewChatRequested(agentPayload.agent);
				else await this.taskActions.newChat(agentPayload.agent);
				break;
			}
			case "action.answerPlanQuestion": {
				if (!planPayload || !this.matchAgent(envelope, planPayload)) return this.failAction(socket, envelope, "unauthorized", "Agent/task binding mismatch");
				const input = this.planInputs.get(planPayload.requestId);
				const question = input?.questions[input.questionIndex];
				if (!input || input.taskId !== planPayload.taskId || input.threadId !== this.taskRegistry.getTask(planPayload.taskId)?.externalId || question?.id !== planPayload.questionId) {
					return this.failAction(socket, envelope, "stale-request", "Plan question is no longer active");
				}
				if (planPayload.optionIndex < 0 || planPayload.optionIndex >= question.options.length) return this.failAction(socket, envelope, "stale-request", "Plan option is invalid");
				try {
					if (input.requestId.startsWith("managed:")) {
						if (!this.managedCodex) throw new Error("Managed Codex is unavailable");
						await this.managedCodex.answerPlanChoice(input.taskId, input.requestId, planPayload.questionId, planPayload.optionIndex);
					} else {
						if (!this.codexBridge) throw new Error("Codex app-server is unavailable");
						await this.codexBridge.answer(input.requestId, input.taskId, planPayload.questionId, planPayload.optionIndex);
					}
				} catch (error) {
					return this.failAction(socket, envelope, "stale-request", error instanceof Error ? error.message : String(error));
				}
				break;
			}
			case "action.open":
			case "action.review":
			case "action.verify": {
				if (!payload || !this.matchAgent(envelope, payload)) return this.failAction(socket, envelope, "unauthorized", "Agent/task binding mismatch");
				const task = this.taskRegistry.getTask(payload.taskId);
				if (!task) return this.failAction(socket, envelope, "not-found", "Task no longer exists");
				if (envelope.type === "action.open" && (!task.capabilities.device.open || !task.openRef.value)) return this.failAction(socket, envelope, "unauthorized", "Task has no open target");
				if (envelope.type === "action.review" && (!task.capabilities.device.review || !task.reviewRef)) return this.failAction(socket, envelope, "unauthorized", "Task does not expose a review capability");
				if (envelope.type === "action.verify" && (!task.capabilities.device.verify || !task.verifyProfile || task.workflow?.state === "running")) return this.failAction(socket, envelope, "unauthorized", "Task does not expose an available verification capability");
				await this.taskActions.runReadAction(envelope.type.slice("action.".length) as "open" | "review" | "verify", task);
				break;
			}
		}

		if (envelope.type === "action.selectTask" && payload) this.monitor.selectAgent(payload.agent);
		if ((envelope.type === "action.openAgent" || envelope.type === "action.focusAgent") && agentPayload) this.monitor.selectAgent(agentPayload.agent);
		this.broadcastStatus();
		this.recordAction(envelope, "ok");
		this.send(socket, createEnvelope<AckPayload>("ack", { ok: true, forRequestId: envelope.requestId }));
	}

	private failAction(socket: WebSocket, envelope: IpcEnvelope, code: ErrorPayload["code"], message: string): void {
		this.recordAction(envelope, "error", code);
		this.sendError(socket, code, message, envelope.requestId);
	}

	private recordAction(envelope: IpcEnvelope, outcome: "ok" | "error", detail?: string): void {
		const raw = envelope.payload && typeof envelope.payload === "object" ? envelope.payload as Record<string, unknown> : {};
		const agent = raw.agent === "codex" || raw.agent === "claude" ? raw.agent : undefined;
		this.audit.record({
			action: envelope.type.replace(/^action\./, ""),
			agent,
			taskId: typeof raw.taskId === "string" ? raw.taskId : undefined,
			requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
			clientRequestId: envelope.requestId,
			outcome,
			detail,
		});
	}

	private matchAgent(envelope: IpcEnvelope, payload: TaskActionPayload): boolean {
		const task = this.taskRegistry.getTask(payload.taskId);
		return !!task && task.agent === payload.agent && (!envelope.agentId || envelope.agentId === payload.agent);
	}

	private matchEnvelopeAgent(envelope: IpcEnvelope, agent: AgentKind): boolean {
		return !envelope.agentId || envelope.agentId === agent;
	}

	private isCurrentCodexApproval(taskId: string, requestId: string): boolean {
		const task = this.taskRegistry.getTask(taskId);
		return task?.agent === "codex"
			&& task.status === "APPROVAL"
			&& task.request?.requestId === requestId
			&& task.request.decisionPath === "codex-shortcut"
			&& !this.submittedCodexRequests.has(requestId);
	}

	private handlePlanInput(input: PendingPlanInput): void {
		const isNewRequest = !this.planInputs.has(input.requestId);
		this.planInputs.set(input.requestId, input);
		if (isNewRequest) this.taskRegistry.markPlanInput(input.taskId);
		this.broadcastSnapshot();
	}

	private handlePlanInputCleared(requestId: string): void {
		if (!this.planInputs.delete(requestId)) return;
		this.broadcastSnapshot();
	}

	private adapterContext() {
		return {
			registry: this.taskRegistry,
			upsertTask: (task: import("@streamdeck-supervisor/shared").Task) => {
				let incoming = task;
				if (incoming.agent === "codex") {
					for (const [requestId, taskId] of this.submittedCodexRequests) {
						if (taskId === incoming.taskId && (incoming.status !== "APPROVAL" || incoming.request?.requestId !== requestId)) this.submittedCodexRequests.delete(requestId);
					}
					if (incoming.request && this.submittedCodexRequests.get(incoming.request.requestId) === incoming.taskId) {
						incoming = {
							...incoming,
							capabilities: {
								...incoming.capabilities,
								desktop: { ...incoming.capabilities.desktop, approve: false, reject: false },
							},
						};
					}
				}
				this.taskRegistry.upsertTask(enrichTaskWithProject(incoming, this.config));
			},
			removeTask: (taskId: string) => this.taskRegistry.removeTask(taskId),
			setStatus: (adapter: "claude" | "codex", status: AdapterStatus["status"], lastError?: string) => {
				this.adapterStatuses[adapter] = { status, lastPollAt: Date.now(), ...(lastError ? { lastError } : {}) };
				this.broadcastStatus();
			},
		};
	}

	private broadcastStatus(): void {
		const status = this.status;
		for (const client of this.clients) this.send(client.socket, createEnvelope("system.status", status));
	}

	private broadcastSnapshot(): void {
		const payload = this.snapshotPayload();
		for (const client of this.clients) this.send(client.socket, createEnvelope("system.snapshot", payload));
	}

	private sendSnapshot(socket: WebSocket): void {
		this.send(socket, createEnvelope<SystemSnapshotPayload>("system.snapshot", this.snapshotPayload()));
	}

	private snapshotPayload(): SystemSnapshotPayload {
		const planInputs = [...this.planInputs.values()].sort((a, b) => {
			const taskA = this.taskRegistry.getTask(a.taskId);
			const taskB = this.taskRegistry.getTask(b.taskId);
			return planPriority(taskA?.status) - planPriority(taskB?.status) || (taskB?.lastEventAt ?? 0) - (taskA?.lastEventAt ?? 0);
		});
		return { ...this.taskRegistry.getSnapshot(this.status), planInputs };
	}

	private sendError(socket: WebSocket, code: ErrorPayload["code"], message: string, forRequestId?: string): void {
		this.send(socket, createEnvelope<ErrorPayload>("error", { ok: false, code, message, forRequestId }));
	}

	private send(socket: WebSocket, envelope: IpcEnvelope): void {
		if (socket.readyState === WebSocket.OPEN) socket.send(encodeEnvelope(envelope));
	}

	private rawText(raw: RawData): string {
		return typeof raw === "string" ? raw : raw.toString();
	}
}

function completedTasksPayload(value: unknown): DismissCompletedDeviceTasksPayload | null {
 if (!value || typeof value !== "object") return null;
 const candidate = value as DismissCompletedDeviceTasksPayload;
 if (!["codex", "claude"].includes(candidate.agent) || !Array.isArray(candidate.executions) || candidate.executions.length > 64) return null;
 if (!candidate.executions.every(item => item && typeof item.taskId === "string" && item.taskId.length > 0
  && typeof item.executionId === "string" && item.executionId.length > 0)) return null;
 return candidate;
}

function preparePersistedTask(task: Task): Task {
	const rawPath = task.request?.decisionPath as string | null | undefined;
	const decisionPath: NonNullable<Task["request"]>["decisionPath"] = rawPath === "hook-blocking" ? "claude-hook"
		: rawPath === "codex-shortcut" || rawPath === "claude-hook" ? rawPath
			: null;
	const request = task.request ? { ...task.request, decisionPath } : undefined;
	const prepared = {
		...task,
		...(request ? { request } : {}),
		capabilities: {
			...task.capabilities,
			desktop: { ...task.capabilities.desktop, interrupt: false },
		},
	};
	if (task.status !== "APPROVAL") return prepared;
	if (task.agent === "claude") {
		return {
			...prepared,
			status: "STALE",
			request: undefined,
			attentionCount: 0,
			capabilities: {
				...task.capabilities,
				desktop: { ...task.capabilities.desktop, approve: false, reject: false },
			},
		};
	}
	return {
		...prepared,
		...(request ? { request } : { request: undefined }),
		capabilities: {
			...task.capabilities,
			desktop: { ...task.capabilities.desktop, approve: false, reject: false },
		},
	};
}
