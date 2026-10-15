import fs from "node:fs";
import path from "node:path";

export const AGENT_FOLDER_KINDS = ["codex", "claude", "claudeDesktop"] as const;
export type AgentFolderKind = typeof AGENT_FOLDER_KINDS[number];
interface FolderGrant { path: string; bookmark: string }

/** Bookmarks stay in the app container; the renderer only receives folder paths. */
export class AgentFolderAccess {
	private grants: Partial<Record<AgentFolderKind, FolderGrant>> = {};
	private active = new Map<AgentFolderKind, () => void>();

	constructor(private readonly file: string, private readonly startAccess: (bookmark: string) => () => void) {}

	restore(): void {
		this.close();
		let saved: unknown;
		try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return; }
		if (!saved || typeof saved !== "object") return;
		for (const kind of AGENT_FOLDER_KINDS) {
			const grant = (saved as Record<string, FolderGrant>)[kind];
			if (!grant || typeof grant.path !== "string" || !path.isAbsolute(grant.path) || typeof grant.bookmark !== "string" || !grant.bookmark) continue;
			let stop: (() => void) | undefined;
			try {
				stop = this.startAccess(grant.bookmark);
				if (!fs.statSync(grant.path).isDirectory()) throw new Error("Folder no longer exists");
				this.grants[kind] = grant;
				this.active.set(kind, stop);
			} catch { stop?.(); }
		}
	}

	set(kind: AgentFolderKind, folder: string, bookmark: string): void {
		if (!AGENT_FOLDER_KINDS.includes(kind) || !path.isAbsolute(folder) || !bookmark) throw new Error("Invalid folder access. Please choose the folder again.");
		const stop = this.startAccess(bookmark);
		try {
			if (!fs.statSync(folder).isDirectory()) throw new Error("Please choose a folder.");
			const next = { ...this.grants, [kind]: { path: folder, bookmark } };
			this.persist(next);
			this.active.get(kind)?.();
			this.grants = next;
			this.active.set(kind, stop);
		} catch (error) { stop(); throw error; }
	}

	get(kind: AgentFolderKind): string | undefined { return this.active.has(kind) ? this.grants[kind]?.path : undefined; }
	revoke(kind: AgentFolderKind): void {
		if (!AGENT_FOLDER_KINDS.includes(kind)) throw new Error("Invalid agent folder type");
		const next = { ...this.grants };
		delete next[kind];
		this.persist(next);
		this.active.get(kind)?.();
		this.active.delete(kind);
		this.grants = next;
	}
	revokeAll(): void {
		this.persist({});
		this.close();
	}
	private persist(grants: Partial<Record<AgentFolderKind, FolderGrant>>): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(grants), { mode: 0o600 });
		fs.renameSync(temporary, this.file);
	}
	paths(): Partial<Record<AgentFolderKind, string>> {
		return Object.fromEntries(AGENT_FOLDER_KINDS.flatMap(kind => this.get(kind) ? [[kind, this.get(kind)!]] : []));
	}
	close(): void {
		for (const stop of this.active.values()) stop();
		this.active.clear();
		this.grants = {};
	}
}
