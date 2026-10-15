import type { SupervisorConfig } from "@streamdeck-supervisor/daemon";

type LoginPreferences = Pick<SupervisorConfig["device"], "startAtLogin" | "loginItemConsentVersion">;
export interface LoginItemSystem {
	get(): boolean;
	set(enabled: boolean): void;
}

/** Startup can remove an unconsented registration, but must never register one. */
export function reconcileLoginItem(preferences: LoginPreferences, system: LoginItemSystem): LoginPreferences {
	const consented = preferences.loginItemConsentVersion === 1 && preferences.startAtLogin;
	if (!consented && system.get()) {
		system.set(false);
		if (system.get()) throw new Error("Could not disable the legacy login item. Turn off Agent Pulse in macOS Login Items.");
	}
	return { ...preferences, startAtLogin: consented && system.get() };
}

/** Only the dedicated toggle's explicit choice may create a login registration. */
export function saveLoginItemChoice(preferences: LoginPreferences, choice: unknown, system: LoginItemSystem): LoginPreferences {
	if (choice === undefined) return reconcileLoginItem(preferences, system);
	if (typeof choice !== "boolean") throw new Error("Invalid launch at login setting.");
	system.set(choice);
	if (system.get() !== choice) throw new Error("The launch at login change did not take effect. Check macOS Login Items.");
	return { startAtLogin: choice, loginItemConsentVersion: 1 };
}

export interface LaunchContext {
	argv: readonly string[];
	isPackaged: boolean;
	platform: NodeJS.Platform;
	wasOpenedAtLogin?: boolean;
}

/** Login launches stay headless; direct user launches open the settings window. */
export function shouldStartInBackground(context: LaunchContext): boolean {
	if (context.argv.includes("--hidden")) return true;
	return context.isPackaged && context.platform === "darwin" && context.wasOpenedAtLogin === true;
}

/** macOS reports login launches itself; command-line login arguments are Windows-only. */
export function loginItemSettings(openAtLogin: boolean, platform: NodeJS.Platform): {
	openAtLogin: boolean;
	args?: string[];
} {
	return platform === "win32" ? { openAtLogin, args: ["--hidden"] } : { openAtLogin };
}
