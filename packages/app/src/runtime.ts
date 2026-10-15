import type {
	AgentKind, DesktopIntegrationStatus, DeviceConnectionStatus,
	ManagedTaskDetail, NeoDeviceInfo, ReasoningEffort, SystemStatus, Task,
} from "@streamdeck-supervisor/shared";
import { IpcServer, type CodexApprovalControl, type SupervisorConfig } from "@streamdeck-supervisor/daemon";
import { DeviceController, daemonClient, scanNeoDevices } from "@streamdeck-supervisor/device";

const STOPPED_DEVICE: DeviceConnectionStatus = { state: "STOPPED", devices: [] };

export class SupervisorRuntime {
	private server: IpcServer | undefined;
	private controller: DeviceController | undefined;
	private deviceStatus: DeviceConnectionStatus = structuredClone(STOPPED_DEVICE);
	private running = false;
	private lastError: string | undefined;
	private scanCache: { at: number; devices: NeoDeviceInfo[] } = { at: 0, devices: [] };

	constructor(
		private readonly codexApprovalControl: CodexApprovalControl,
		private readonly getLoginItemEnabled: () => boolean | undefined = () => undefined,
		private readonly getDesktopIntegration: () => DesktopIntegrationStatus | undefined = () => undefined,
		private readonly onNewChatRequested?: (agent: AgentKind) => void,
		private readonly observerOnly = false,
	) {}

	async start(config: SupervisorConfig): Promise<void> {
		await this.stop();
		this.lastError = undefined;
		try {
			this.server = new IpcServer({
				adapterMode: "real",
				config,
				codexPlanRelayEnabled: false,
				observerOnly: this.observerOnly,
				codexApprovalControl: this.codexApprovalControl,
				getDeviceConnection: () => this.connectionStatus,
				getLoginItemEnabled: this.getLoginItemEnabled,
				getDesktopIntegration: this.getDesktopIntegration,
				...(this.onNewChatRequested ? { onNewChatRequested: this.onNewChatRequested } : {}),
			});
			await this.server.start();
			this.running = true;
			if (config.device.mode === "ai") await this.startDevice(config.device.serialNumber);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			await this.stop();
			throw error;
		}
	}

	async restart(config: SupervisorConfig): Promise<void> {
		await this.start(config);
	}

	async stop(): Promise<void> {
		daemonClient.stop();
		if (this.controller) await this.controller.stop().catch(() => undefined);
		this.controller = undefined;
		this.deviceStatus = structuredClone(STOPPED_DEVICE);
		if (this.server) await this.server.stop().catch(() => undefined);
		this.server = undefined;
		this.running = false;
	}

	setSuspended(value: boolean): void { this.server?.setSuspended(value); }

	get isRunning(): boolean { return this.running; }
	get error(): string | undefined { return this.lastError; }
	get systemStatus(): SystemStatus | undefined { return this.server?.status; }
	get connectionStatus(): DeviceConnectionStatus { return structuredClone(this.deviceStatus); }
	get tasks(): Task[] { return this.server?.getTasks() ?? []; }
	get managedDetails(): ManagedTaskDetail[] { return this.server?.getManagedDetails() ?? []; }

	async sendManagedMessage(taskId: string, text: string): Promise<ManagedTaskDetail> { return this.requireServer().sendManagedMessage(taskId, text); }
	async retryManagedMessage(taskId: string, messageId: string): Promise<ManagedTaskDetail> { return this.requireServer().retryManagedMessage(taskId, messageId); }
	async updateManagedSettings(taskId: string, settings: { model?: string; effort?: ReasoningEffort }): Promise<void> { await this.requireServer().updateManagedSettings(taskId, settings); }
	async interruptTask(taskId: string): Promise<void> { await this.requireServer().interruptDesktopTask(taskId); }
	async decideRequest(taskId: string, requestId: string, decision: "approve" | "reject"): Promise<void> { await this.requireServer().decideDesktopRequest(taskId, requestId, decision); }
	async answerRequest(taskId: string, requestId: string, answers: Record<string, string[]>): Promise<void> { await this.requireServer().answerManagedRequest(taskId, requestId, answers); }
	async openAgent(agent: AgentKind, newChat = false): Promise<void> { await this.requireServer().openDesktopAgent(agent, newChat); }
	async openTask(taskId: string): Promise<void> { await this.requireServer().openDesktopTask(taskId); }

	async scanDevices(force = false): Promise<NeoDeviceInfo[]> {
		if (!force && Date.now() - this.scanCache.at < 3_000) return structuredClone(this.scanCache.devices);
		try {
			const devices = await scanNeoDevices();
			this.scanCache = { at: Date.now(), devices };
			return structuredClone(devices);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return [];
		}
	}

	private async startDevice(serialNumber?: string): Promise<void> {
		this.controller = new DeviceController({
			...(serialNumber ? { serialNumber } : {}),
			onStatus: (status) => { this.deviceStatus = status; },
		});
		daemonClient.start(this.observerOnly ? () => this.requireServer().connectInProcess() : undefined);
		await this.controller.start();
	}

	private requireServer(): IpcServer {
		if (!this.server) throw new Error("Supervisor runtime is not running");
		return this.server;
	}
}
