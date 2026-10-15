import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { app } from "electron";

export interface NativeMacOSControl {
	preflightPostEventAccess(): boolean;
	requestPostEventAccess(): boolean;
	frontmostBundleId(): string;
	activateCodexThread(url: string): boolean;
	postDecision(decision: "approve" | "reject"): boolean;
}

const require = createRequire(import.meta.url);

export function loadNativeMacOSControl(): NativeMacOSControl | undefined {
	if (process.platform !== "darwin" || process.arch !== "arm64") return undefined;
	const modulePath = app.isPackaged
		? path.join(process.resourcesPath, "build-native", "macos-control.node")
		: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build-native", "macos-control.node");
	return require(modulePath) as NativeMacOSControl;
}
