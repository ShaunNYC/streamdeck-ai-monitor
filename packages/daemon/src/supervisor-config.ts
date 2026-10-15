import fs from "node:fs";
import path from "node:path";
import type { Task, VerifyProfile } from "@streamdeck-supervisor/shared";
import { getDataDirectory } from "./config.js";

export interface SupervisorProject {
	id: string;
	label: string;
	cwd: string;
	verify?: VerifyProfile;
}

export interface SupervisorAgentConfig {
	enabled: boolean;
	stateDirectory?: string;
	transcriptDirectory?: string;
	desktopSessionDirectory?: string;
}

export interface SupervisorConfig {
	version: 2;
	projects: SupervisorProject[];
	agents: {
		codex: SupervisorAgentConfig;
		claude: SupervisorAgentConfig;
	};
	device: {
		mode: "ai" | "official";
		serialNumber?: string;
		startAtLogin: boolean;
		loginItemConsentVersion?: 1;
		showInMenuBar: boolean;
	};
}

interface LegacySupervisorConfig {
	version?: 1;
	projects?: unknown;
	claude?: { transcriptDirectory?: unknown };
	codex?: { stateDirectory?: unknown };
}

const EMPTY_CONFIG: SupervisorConfig = {
	version: 2,
	projects: [],
	agents: { codex: { enabled: true }, claude: { enabled: true } },
	device: { mode: "ai", startAtLogin: false, showInMenuBar: true },
};

export function getConfigPath(): string {
	return process.env.AI_CONTROL_SUPERVISOR_CONFIG ?? path.join(getDataDirectory(), "config.json");
}

export function loadSupervisorConfig(): SupervisorConfig {
	try {
		return normalizeSupervisorConfig(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")));
	} catch {
		return structuredClone(EMPTY_CONFIG);
	}
}

export function defaultSupervisorConfig(cwd: string): SupervisorConfig {
	return {
		version: 2,
		projects: [{
			id: path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "project",
			label: path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 9).toUpperCase() || "PROJECT",
			cwd: path.resolve(cwd),
		}],
		agents: { codex: { enabled: true }, claude: { enabled: true } },
		device: { mode: "ai", startAtLogin: false, showInMenuBar: true },
	};
}

export function normalizeSupervisorConfig(input: unknown): SupervisorConfig {
	const value = input && typeof input === "object" && !Array.isArray(input)
		? input as Partial<SupervisorConfig> & LegacySupervisorConfig
		: {};
	const projects = Array.isArray(value.projects)
		? value.projects.filter(isProject).map(normalizeProject)
		: [];
	const legacyClaude = value.claude && typeof value.claude === "object" ? value.claude : {};
	const legacyCodex = value.codex && typeof value.codex === "object" ? value.codex : {};
	const agents = value.agents && typeof value.agents === "object" ? value.agents : undefined;
	const device = value.device && typeof value.device === "object" ? value.device : undefined;
	return {
		version: 2,
		projects,
		agents: {
			codex: normalizeAgent(agents?.codex, "stateDirectory", legacyCodex.stateDirectory),
			claude: normalizeAgent(agents?.claude, "transcriptDirectory", legacyClaude.transcriptDirectory),
		},
		device: {
			mode: device?.mode === "official" ? "official" : "ai",
			// Older builds defaulted to true; that value is not evidence of consent.
			startAtLogin: device?.startAtLogin === true && device?.loginItemConsentVersion === 1,
			...(device?.loginItemConsentVersion === 1 ? { loginItemConsentVersion: 1 as const } : {}),
			showInMenuBar: device?.showInMenuBar !== false,
			...(typeof device?.serialNumber === "string" && device.serialNumber ? { serialNumber: device.serialNumber } : {}),
		},
	};
}

export function saveSupervisorConfig(config: SupervisorConfig): SupervisorConfig {
	const normalized = normalizeSupervisorConfig(config);
	const configPath = getConfigPath();
	fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
	if (fs.existsSync(configPath)) {
		fs.copyFileSync(configPath, `${configPath}.bak`);
		try { fs.chmodSync(`${configPath}.bak`, 0o600); } catch { /* best effort */ }
	}
	const temporary = `${configPath}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, configPath);
	try { fs.chmodSync(configPath, 0o600); } catch { /* best effort */ }
	return normalized;
}

/** Applies only configured, non-secret project metadata to an incoming task. */
export function enrichTaskWithProject(task: Task, config: SupervisorConfig): Task {
	const project = config.projects
		.filter((candidate) => task.projectId === candidate.cwd || task.projectId.startsWith(`${candidate.cwd}${path.sep}`))
		.sort((a, b) => b.cwd.length - a.cwd.length)[0];
	if (!project) return task;
	return {
		...task,
		projectId: project.id,
		projectLabel: project.label,
		cwd: task.cwd ?? project.cwd,
		verifyProfile: project.verify ?? task.verifyProfile,
	};
}

function isProject(value: unknown): value is SupervisorProject {
	if (!value || typeof value !== "object") return false;
	const project = value as Record<string, unknown>;
	return typeof project.id === "string" && typeof project.label === "string" && typeof project.cwd === "string";
}

function normalizeProject(project: SupervisorProject): SupervisorProject {
	const cwd = path.resolve(project.cwd);
	const verify = project.verify && typeof project.verify.command === "string" && project.verify.command.trim()
		? {
			command: project.verify.command.trim(),
			cwd: path.resolve(project.verify.cwd || cwd),
			timeoutMs: Math.max(1_000, Math.min(900_000, Number(project.verify.timeoutMs) || 180_000)),
		}
		: undefined;
	return {
		id: project.id.trim() || path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "project",
		label: project.label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 9).toUpperCase() || "PROJECT",
		cwd,
		...(verify ? { verify } : {}),
	};
}

function normalizeAgent(
	value: SupervisorAgentConfig | undefined,
	directoryKey: "stateDirectory" | "transcriptDirectory",
	legacyDirectory: unknown,
): SupervisorAgentConfig {
	const directory = typeof value?.[directoryKey] === "string"
		? value[directoryKey]
		: typeof legacyDirectory === "string" ? legacyDirectory : undefined;
	return {
		enabled: value?.enabled !== false,
		...(typeof value?.desktopSessionDirectory === "string" && value.desktopSessionDirectory ? { desktopSessionDirectory: path.resolve(value.desktopSessionDirectory) } : {}),
		...(directory ? { [directoryKey]: path.resolve(directory) } : {}),
	};
}
