import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type SupervisorBridge } from "./app-types.js";

const bridge: SupervisorBridge = {
	getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.status),
	chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
	chooseAgentFolder: (kind) => ipcRenderer.invoke(IPC_CHANNELS.chooseAgentFolder, kind),
	revokeAgentFolder: (kind) => ipcRenderer.invoke(IPC_CHANNELS.revokeAgentFolder, kind),
	saveSettings: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, request),
	setMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setMode, mode),
	runDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.diagnostics),
	requestCodexApprovalPermission: () => ipcRenderer.invoke(IPC_CHANNELS.requestCodexApprovalPermission),
	repairCodexApprovalPermission: () => ipcRenderer.invoke(IPC_CHANNELS.repairCodexApprovalPermission),
	rebuildMenuBarIcon: () => ipcRenderer.invoke(IPC_CHANNELS.rebuildMenuBarIcon),
	removeIntegration: () => ipcRenderer.invoke(IPC_CHANNELS.removeIntegration),
};

contextBridge.exposeInMainWorld("supervisor", bridge);
