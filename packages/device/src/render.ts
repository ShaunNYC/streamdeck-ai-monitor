import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { redactSensitiveText, type AgentKind, type PlanOption, type Task, type TaskStatus } from "@streamdeck-supervisor/shared";

const require = createRequire(import.meta.url);
const APP_SVGS: Record<AgentKind, string> = {
	codex: fs.readFileSync(new URL("../assets/codex-color.svg", import.meta.url), "utf8"),
	claude: fs.readFileSync(new URL("../assets/claude-color.svg", import.meta.url), "utf8"),
};
const APP_IMAGES: Record<AgentKind, string> = {
	codex: Buffer.from(APP_SVGS.codex).toString("base64"),
	claude: Buffer.from(APP_SVGS.claude).toString("base64"),
};
const QUIET_APP_IMAGES: Record<AgentKind, string> = {
	codex: Buffer.from(makeQuietCodexSvg(APP_SVGS.codex)).toString("base64"),
	claude: APP_IMAGES.claude,
};
const LUCIDE_CACHE = new Map<string, string>();

const C = {
	canvas: "#000000",
	surfaceA: "#07101C",
	surfaceB: "#111A28",
	text: "#F8FAFC",
	soft: "#C8D2E0",
	muted: "#667386",
	quietRing: "#3B4654",
	quietIcon: "#7C8795",
	quietText: "#A5AFBC",
	codex: "#7A9DFF",
	claude: "#D97757",
	running: "#1EC8FF",
	approval: "#FFB224",
	input: "#B47CFF",
	done: "#35D980",
	error: "#FF4D68",
	open: "#50D7FF",
	review: "#8C9CFF",
	verify: "#42DFC0",
	reject: "#FF4D68",
	approve: "#42D981",
	control: "#FF3F5F",
} as const;

export interface TaskRenderOptions { overflowCount?: number; }
export interface TextLayoutOptions {
	maxWidth: number;
	maxLines: number;
	sizes: readonly number[];
	letterSpacing?: number;
}
export interface TextLayout {
	lines: string[];
	size: number;
	lineHeight: number;
	widths: number[];
	truncated: boolean;
}
export interface InfobarOptions {
	offline?: boolean;
	setup?: boolean;
	busy?: boolean;
	degradedAgent?: AgentKind;
	runningCount: number;
	pageLabel?: string;
	overflowCount?: number;
	approval?: { agent: AgentKind; target: string };
	notice?: { label: "RESOLVED ELSEWHERE" | "APPROVAL EXPIRED"; detail: string; kind: "resolved" | "expired" };
	waitingInput?: AgentKind;
	plan?: { questionNumber: number; totalQuestions: number; optionCount: number; question: string };
	error?: { agent: AgentKind; detail?: string };
	recap?: string;
}
export interface InfobarLayout {
	label: string;
	accent: string;
	detail?: string;
	detailWidth: number;
	detailViewportWidth: number;
	contentKey: string;
}
export interface InfobarRenderOptions { scrollOffset?: number; }
export type TileEmphasis = "quiet" | "active" | "attention" | "done" | "error";
export interface MainTileModel {
	label: string;
	detail?: string;
	/** Preserve terminal process data in neutral grey without implying live work. */
	mutedDetail?: boolean;
	accent: string;
	actionable: boolean;
	emphasis: TileEmphasis;
	icon?: string;
	agent?: AgentKind;
	badge?: string;
	hold?: boolean;
	holdProgress?: number;
	process?:
		| { kind: "activity"; value: string; footer?: string }
		| { kind: "progress"; completed: number; total: number; liveTaskCount: number; unknownCount?: number; estimatedRemainingMs?: number };
}

export const INFOBAR_MARQUEE_INITIAL_MS = 1_200;
export const INFOBAR_MARQUEE_END_MS = 800;
export const INFOBAR_MARQUEE_SPEED_PX_PER_SECOND = 24;
export const INFOBAR_MARQUEE_FRAME_MS = 200;
const KEY_CONTENT_X = 14;
const KEY_CONTENT_WIDTH = 68;
const INFOBAR_DETAIL_X = 16;
const INFOBAR_DETAIL_WIDTH = 216;

export async function rasterizeSvg(svg: string, width: number, height: number): Promise<Uint8Array> {
	const { data } = await sharp(Buffer.from(svg)).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return data;
}

/** Live task card: fixed metadata columns, two-line title, one activity line, one status pill. */
export function renderTaskCard(task: Task, options: TaskRenderOptions = {}): string {
	const visual = statusVisual(task.status, task.agent);
	const progress = task.progress ?? { todoCompleted: 0, todoTotal: 0, activeSubagents: 0, totalSubagents: 0, durationMs: 0, queueLength: 0, queueFailed: 0 };
	const activity = progress.latestActivity?.label ?? (task.status === "DONE" || task.status === "DONE_UNREAD" ? "Completed" : "No recent activity");
	const todo = progress.todoTotal > 0 ? `${progress.todoCompleted}/${progress.todoTotal}` : "";
	const project = layoutText(task.projectLabel.toUpperCase(), { maxWidth: todo ? 45 : KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8], letterSpacing: 0.45 });
	const todoLayout = layoutText(todo, { maxWidth: 22, maxLines: 1, sizes: [8], letterSpacing: 0.15 });
	const title = layoutText(task.titleShort, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 2, sizes: [10.5, 10, 9.5] });
	const activityLine = layoutText(activity, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8.5, 8] });
	const firstTitleY = title.lines.length === 1 ? 39 : 32;
	const statusLabel = options.overflowCount ? `${visual.label === "RUNNING" ? "RUN" : visual.label} · +${options.overflowCount}` : visual.label;
	const status = layoutText(statusLabel, { maxWidth: 68, maxLines: 1, sizes: [8.2, 8], letterSpacing: 0.65 });
	return svg96([
		defs(visual.accent, visual.tint),
		clip("taskMeta", KEY_CONTENT_X, 9, KEY_CONTENT_WIDTH, 11),
		clip("taskTitle", KEY_CONTENT_X, 23, KEY_CONTENT_WIDTH, 29),
		clip("taskActivity", KEY_CONTENT_X, 53, KEY_CONTENT_WIDTH, 12),
		clip("taskStatus", 16, 69, 64, 13),
		cardShell(visual.accent),
		text(project.lines[0] ?? "", KEY_CONTENT_X, 17, project.size, visual.accent, "800", "start", 0.45, 'clip-path="url(#taskMeta)"'),
		todo ? text(todoLayout.lines[0] ?? "", 84, 17, todoLayout.size, C.soft, "780", "end", 0.15, 'clip-path="url(#taskMeta)"') : "",
		...title.lines.map((line, index) => text(line, KEY_CONTENT_X, firstTitleY + index * title.lineHeight, title.size, C.text, "790", "start", 0, 'clip-path="url(#taskTitle)"')),
		text(activityLine.lines[0] ?? "", KEY_CONTENT_X, 62, activityLine.size, C.soft, "650", "start", 0, 'clip-path="url(#taskActivity)"'),
		`<rect x="12" y="68" width="72" height="17" rx="8.5" fill="#010407" fill-opacity=".78" stroke="${visual.accent}" stroke-width="1"/>`,
		text(status.lines[0] ?? "", 48, 79.8, status.size, visual.accent, "850", "middle", 0.65, 'clip-path="url(#taskStatus)"'),
	].join(""));
}

/** Empty live-task slot: identifiable Agent surface, deliberately non-actionable. */
export function renderEmptySlot(agent: AgentKind): string {
	return svg96([
		quietDefs(),
		quietShell(),
		quietAgentIcon(agent, "slot"),
	].join(""), 'data-emphasis="quiet" data-role="empty-slot"');
}

/** A high-contrast choice tile used only while Codex Plan Mode is awaiting input. */
export function renderPlanChoiceTile(option: PlanOption, marker: string): string {
	const content = layoutText(option.description, { maxWidth: 70, maxLines: 3, sizes: [11.5, 10.5, 9.5], letterSpacing: 0.1 });
	const firstY = content.lines.length === 1 ? 58 : content.lines.length === 2 ? 50 : 42;
	return svg96([
		`<defs><filter id="choiceShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="#000" flood-opacity=".28"/></filter></defs>`,
		clip("choiceText", 12, 31, 72, 49),
		`<rect x="4" y="4" width="88" height="88" rx="14" fill="#F7F9FC" stroke="#D8E0EB" stroke-width="2" filter="url(#choiceShadow)"/>`,
		`<circle cx="17" cy="17" r="9" fill="${C.codex}"/><text x="17" y="20.1" text-anchor="middle" font-family="${fontFamily()}" font-size="10" font-weight="900" fill="#FFFFFF">${escapeXml(marker)}</text>`,
		...content.lines.map((line, index) => text(line, 48, firstY + index * content.lineHeight, content.size, "#18202C", "820", "middle", 0.1, 'clip-path="url(#choiceText)"')),
	].join(""), `data-role="plan-option" data-marker="${escapeXml(marker)}" data-label="${escapeXml(option.label)}"`);
}

export function renderSystemTile(label: string, detail: string, accent: string = C.error, icon = "wifi-off"): string {
	const title = layoutText(label, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 2, sizes: [10.5, 10, 9.5], letterSpacing: 0.1 });
	const detailLine = layoutText(detail, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8.5, 8], letterSpacing: 0.45 });
	const firstTitleY = title.lines.length === 1 ? 58 : 50;
	return svg96([
		defs(accent, tintFor(accent)),
		clip("systemTitle", KEY_CONTENT_X, 40, KEY_CONTENT_WIDTH, 26),
		clip("systemDetail", KEY_CONTENT_X, 67, KEY_CONTENT_WIDTH, 13),
		cardShell(accent),
		lucide(icon, 37, 13, 22, accent, 2.1),
		...title.lines.map((line, index) => text(line, 48, firstTitleY + index * title.lineHeight, title.size, C.text, "820", "middle", 0.1, 'clip-path="url(#systemTitle)"')),
		text(detailLine.lines[0] ?? "", 48, 78, detailLine.size, accent, "800", "middle", 0.45, 'clip-path="url(#systemDetail)"'),
	].join(""));
}

/** Failure feedback remains explicit. */
export function renderFailureTile(message: string): string {
	return renderSystemTile(message, "TRY AGAIN", C.error, "circle-alert");
}

/** Decision acknowledgements distinguish a local Claude result from a Codex shortcut dispatch. */
export function renderSuccessTile(message: string, detail: string): string {
	return renderSystemTile(message, detail, C.approve, "circle-check");
}

/**
 * Keep the real key artwork and make it feel physically depressed.
 * `progress` is a 0→1→0 envelope supplied by DeviceController.
 */
export function renderPressedTile(svg: string, progress: number): string {
	const envelope = Math.max(0, Math.min(1, progress));
	const scale = 1 - envelope * 0.3;
	const inset = (96 - 96 * scale) / 2;
	const background = /(<rect\s+width="96"\s+height="96"\s+fill="#[0-9A-Fa-f]+"\s*\/>)/.exec(svg)?.[1];
	if (!background) return svg;
	return svg
		.replace(background, `${background}<g data-pressed="true" transform="translate(${inset.toFixed(2)} ${inset.toFixed(2)}) scale(${scale.toFixed(4)})">`)
		.replace(/<\/svg>\s*$/, "</g></svg>");
}

export function renderMainTile(model: MainTileModel): string {
	if (model.label === "NEW CHAT") return renderPlainActionTile(model);
	if (model.agent) return renderAgentTile(model.agent, model.emphasis, model.badge, model.actionable, model.detail);
	if (model.process?.kind === "activity") return renderActivityTile(model, model.process);
	if (model.process?.kind === "progress") return renderProgressTile(model, model.process, Date.now());
	if (model.emphasis === "quiet") return renderQuietActionTile(model);

	const progress = model.holdProgress === undefined ? undefined : Math.max(0, Math.min(1, model.holdProgress));
	const progressFill = progress === undefined ? "" : centerFill(progress, model.accent);
	const label = layoutText(model.label, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [10.8, 10.2, 9.6], letterSpacing: 0.2 });
	const detail = layoutText(model.detail ?? "", { maxWidth: KEY_CONTENT_WIDTH, maxLines: model.label === "TODAY" || model.icon === "circle-gauge" ? 1 : 2, sizes: [8.8, 8.4, 8], letterSpacing: 0.3 });
	const firstDetailY = detail.lines.length === 1 ? 73.5 : 64.5;
	return svg96([
		defs(model.accent, tintFor(model.accent)),
		clip("mainLabel", KEY_CONTENT_X, 42, KEY_CONTENT_WIDTH, 14),
		clip("mainDetail", KEY_CONTENT_X, 58, KEY_CONTENT_WIDTH, 22),
		model.emphasis === "attention" ? attentionHalo(model.accent) : "",
		cardShell(model.accent),
		progressFill,
		lucide(model.icon ?? "circle", 37, 13, 22, model.accent, 2.15),
		text(label.lines[0] ?? "", 48, 51.5, label.size, C.text, "850", "middle", 0.2, 'clip-path="url(#mainLabel)"'),
		...detail.lines.map((line, index) => text(line, 48, firstDetailY + index * detail.lineHeight, detail.size, model.accent, "820", "middle", 0.3, 'clip-path="url(#mainDetail)"')),
		model.hold ? `<rect x="9" y="8" width="32" height="14" rx="7" fill="#020408" stroke="${model.accent}" stroke-width="1"/><text x="25" y="18.2" text-anchor="middle" font-family="${fontFamily()}" font-size="8" font-weight="850" fill="${model.accent}">HOLD</text>` : "",
	].join(""), `data-emphasis="${model.emphasis}" data-actionable="${model.actionable}"`);
}

/** No subtitle: keep the icon/label group centered in both live and idle states. */
function renderPlainActionTile(model: MainTileModel): string {
	const quiet = model.emphasis === "quiet";
	const label = layoutText(model.label, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [10.5, 10, 9, 8], letterSpacing: .2 });
	return svg96([
		quiet ? quietDefs() : defs(model.accent, tintFor(model.accent)),
		quiet ? quietShell() : cardShell(model.accent),
		lucide(model.icon ?? "circle", 37, 24, 22, quiet ? C.quietIcon : model.accent, 2),
		text(label.lines[0] ?? "", 48, 66, label.size, quiet ? C.quietText : C.text, "800", "middle", .2),
	].join(""), `data-role="action" data-emphasis="${model.emphasis}" data-actionable="${model.actionable}"`);
}

function renderActivityTile(model: MainTileModel, process: Extract<NonNullable<MainTileModel["process"]>, { kind: "activity" }>): string {
	if (model.emphasis === "quiet" && !model.mutedDetail) return renderQuietActionTile({ ...model, icon: "activity", process: undefined });
	const muted = model.emphasis === "quiet" || model.mutedDetail === true;
	const accent = muted ? C.muted : model.accent;
	const value = layoutText(process.value, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 2, sizes: [11, 10, 9, 8.5], letterSpacing: 0.15 });
	const footer = process.footer
		? layoutText(process.footer, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8.8, 8.4, 8], letterSpacing: 0.35 })
		: undefined;
	return svg96([
		muted ? quietDefs() : defs(model.accent, tintFor(model.accent)),
		clip("activityLabel", KEY_CONTENT_X, 11, KEY_CONTENT_WIDTH, 14),
		clip("activityValue", KEY_CONTENT_X, 34, KEY_CONTENT_WIDTH, 34),
		clip("activityFooter", KEY_CONTENT_X, 70, KEY_CONTENT_WIDTH, 12),
		muted ? quietShell() : cardShell(model.accent),

		text("ACTIVITY", 48, 22, 10.2, muted ? C.quietText : C.text, "850", "middle", 0.25, 'clip-path="url(#activityLabel)"'),
		value.lines.map((line,index) => text(line,48,(value.lines.length === 1 ? 53 : 45)+index*14,value.size,accent,"880","middle",.15,'clip-path="url(#activityValue)"')).join(""),
		footer ? text(footer.lines[0] ?? "", 48, 79, footer.size, accent, "790", "middle", 0.35, 'clip-path="url(#activityFooter)"') : "",
	].join(""), `data-emphasis="${model.emphasis}" data-role="activity" data-actionable="${model.actionable}"`);
}

function renderProgressTile(model: MainTileModel, process: Extract<NonNullable<MainTileModel["process"]>, { kind: "progress" }>, now: number): string {
	if (model.emphasis === "quiet") {
		return svg96([
			quietDefs(),
			quietShell(),
			text("PROGRESS", 48, 24, 10.2, C.quietText, "800", "middle", 0.25),
			text("—", 48, 51, 18, C.muted, "780", "middle"),
		].join(""), `data-emphasis="quiet" data-role="progress" data-actionable="${model.actionable}" data-ratio="0.0000"`);
	}

	const total = Math.max(0, Math.floor(process.total));
	const completed = Math.max(0, Math.min(total, Math.floor(process.completed)));
	const ratio = total > 0 ? completed / total : 0;
	const taskCount = Math.max(0, Math.floor(process.liveTaskCount));
	const unknown = Math.max(0, process.unknownCount ?? (total === 0 ? taskCount : 0));
	const value = layoutText(total > 0 ? (unknown ? `${completed} / ${total}` : `${Math.round(ratio * 100)}%`) : "WORKING", {
		maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [22, 20, 18, 16, 14, 12], letterSpacing: 0.15,
	});
	const estimate = process.estimatedRemainingMs;
	const eta = estimate === undefined ? undefined : estimate >= 60 * 60000 ? `~${Math.ceil(estimate / 3600000)}H LEFT` : `~${Math.max(1, Math.ceil(estimate / 60000))}M LEFT`;
	const etaLayout = layoutText(eta ?? "", {maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8]});
	const footerText = unknown ? (total ? `+${unknown} NO PLAN` : "NO PLAN") : `${completed}/${total} STEPS`;
	const footer = layoutText(footerText, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8.8, 8.4, 8], letterSpacing: 0.3 });
	return svg96([
		defs(model.accent, tintFor(model.accent)),
		`<defs><clipPath id="progressShellClip"><rect x="5" y="5" width="86" height="86" rx="13"/></clipPath><filter id="progressTextShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation=".8" flood-color="#000" flood-opacity=".86"/></filter></defs>`,
		clip("progressLabel", KEY_CONTENT_X, 13, KEY_CONTENT_WIDTH, 15),
		clip("progressValue", KEY_CONTENT_X, 29, KEY_CONTENT_WIDTH, 32),
		clip("progressFooter", KEY_CONTENT_X, 57, KEY_CONTENT_WIDTH, 25),
		cardShell(model.accent),
		...(taskCount > 0 ? [diagonalSweep(model.accent, now)] : []),
		text("PROGRESS", 48, 24, 10.2, C.text, "860", "middle", 0.2, 'clip-path="url(#progressLabel)" filter="url(#progressTextShadow)"'),
		text(value.lines[0] ?? "", 48, 51, value.size, C.text, "900", "middle", 0.15, 'clip-path="url(#progressValue)" filter="url(#progressTextShadow)"'),
		text(footer.lines[0] ?? "", 48, 67, footer.size, C.text, "790", "middle", 0.3, 'clip-path="url(#progressFooter)" filter="url(#progressTextShadow)" opacity=".9"'),
		eta ? text(etaLayout.lines[0] ?? "", 48, 80, 8, C.soft, "700", "middle") : "",
	].join(""), `data-emphasis="${model.emphasis}" data-role="progress" data-actionable="${model.actionable}" data-ratio="${ratio.toFixed(4)}" data-completed="${completed}" data-total="${total}" data-live-tasks="${taskCount}"`);
}

export function layoutInfobar(options: InfobarOptions): InfobarLayout {
	let label: string;
	let accent: string;
	let detail: string | undefined;
	if (options.busy) { label = "DEVICE BUSY"; accent = C.error; }
	else if (options.offline) { label = "SUPERVISOR OFFLINE"; accent = C.error; }
	else if (options.setup) { label = "SETUP REQUIRED"; accent = C.approval; }
	else if (options.notice) {
		label = options.notice.label;
		accent = options.notice.kind === "expired" ? C.approval : C.done;
		detail = sanitizeInfobarDetail(options.notice.detail, "NO ACTION SENT");
	}
	else if (options.approval) {
		label = `${options.approval.agent.toUpperCase()} APPROVAL`;
		accent = C.approval;
		detail = safeApprovalTarget(options.approval.target);
	}
	else if (options.plan) {
		label = `PLAN Q${options.plan.questionNumber}/${options.plan.totalQuestions} · ${options.plan.optionCount} OPTIONS`;
		accent = C.codex;
		detail = sanitizeInfobarDetail(options.plan.question, "CHOOSE AN OPTION");
	}
	else if (options.waitingInput) {
		label = `${options.waitingInput.toUpperCase()} QUESTION WAITING`;
		accent = C.input;
		detail = `PRESS ${options.waitingInput.toUpperCase()} OR TASK TO OPEN`;
	}
	else if (options.error) {
		label = `${options.error.agent.toUpperCase()} ERROR`;
		accent = C.error;
		detail = safeTerminalDetail(options.error.detail, "TASK FAILED");
	}
	else if (options.recap) {
		label = "RECAP";
		accent = C.done;
		detail = safeTerminalDetail(options.recap, "TASK COMPLETED");
	}
	else if (options.degradedAgent) { label = `${options.degradedAgent.toUpperCase()} SOURCE OFFLINE`; accent = C.error; }
	else if (options.runningCount === 0) { label = "NO TASKS RUNNING"; accent = C.muted; }
	else if (options.runningCount === 1) { label = "1 TASK RUNNING"; accent = C.running; }
	else { label = `${options.runningCount} TASKS RUNNING`; accent = C.running; }
	if (options.pageLabel) detail = [detail, options.pageLabel, options.overflowCount ? `+${options.overflowCount} RUNNING` : undefined].filter(Boolean).join(" · ");
	const detailWidth = detail ? measureText(detail, 10, 0.05) : 0;
	return {
		label,
		accent,
		...(detail ? { detail } : {}),
		detailWidth,
		detailViewportWidth: INFOBAR_DETAIL_WIDTH,
		contentKey: `${label}\u0000${detail ?? ""}\u0000${accent}`,
	};
}

export function infobarMarqueeOffset(overflowPx: number, elapsedMs: number): number {
	if (overflowPx <= 0 || elapsedMs <= INFOBAR_MARQUEE_INITIAL_MS) return 0;
	const travelMs = overflowPx / INFOBAR_MARQUEE_SPEED_PX_PER_SECOND * 1_000;
	const cycleMs = INFOBAR_MARQUEE_INITIAL_MS + travelMs + INFOBAR_MARQUEE_END_MS;
	const cycleElapsed = elapsedMs % cycleMs;
	if (cycleElapsed <= INFOBAR_MARQUEE_INITIAL_MS) return 0;
	if (cycleElapsed >= INFOBAR_MARQUEE_INITIAL_MS + travelMs) return overflowPx;
	return Math.min(overflowPx, (cycleElapsed - INFOBAR_MARQUEE_INITIAL_MS) / 1_000 * INFOBAR_MARQUEE_SPEED_PX_PER_SECOND);
}

export function renderInfobar(options: InfobarOptions, renderOptions: InfobarRenderOptions = {}): string {
	const layout = layoutInfobar(options);
	const { label, accent, detail } = layout;
	const labelX = detail ? 18 : 124;
	const labelAnchor = detail ? "start" : "middle";
	const maxOffset = Math.max(0, layout.detailWidth - layout.detailViewportWidth);
	const scrollOffset = Math.max(0, Math.min(maxOffset, renderOptions.scrollOffset ?? 0));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="248" height="58" viewBox="0 0 248 58">
	<defs><linearGradient id="bar" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#03070C"/><stop offset="1" stop-color="#0D1724"/></linearGradient><clipPath id="detailClip"><rect x="${INFOBAR_DETAIL_X}" y="31" width="${INFOBAR_DETAIL_WIDTH}" height="15"/></clipPath></defs>
	<rect width="248" height="58" fill="#000"/><rect x="4" y="5" width="240" height="48" rx="14" fill="url(#bar)" stroke="${accent}" stroke-width="2" stroke-opacity=".62"/>
	<text x="${labelX}" y="${detail ? 24 : 35}" text-anchor="${labelAnchor}" font-family="${fontFamily()}" font-size="${detail ? 12.2 : 15}" font-weight="760" letter-spacing="${detail ? ".4" : ".55"}" fill="#F7FAFD">${escapeXml(label)}</text>${detail ? `<g clip-path="url(#detailClip)"><g transform="translate(-${scrollOffset.toFixed(2)} 0)"><text x="${INFOBAR_DETAIL_X}" y="43" font-family="${fontFamily()}" font-size="10" font-weight="620" letter-spacing=".05" fill="#C8D2E0">${escapeXml(detail)}</text></g></g>` : ""}</svg>`;
}

function safeTerminalDetail(value: string | undefined, fallback: string): string {
	return sanitizeInfobarDetail(value, fallback);
}

function sanitizeInfobarDetail(value: string | undefined, fallback: string): string {
	return redactSensitiveText(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function safeApprovalTarget(value: string): string {
	return redactSensitiveText(value)
		.replace(/\/Users\/[^/\s]+/g, "~")
		.replace(/\/home\/[^/\s]+/g, "~")
		.replace(/\s+/g, " ")
		.trim() || "PERMISSION REQUEST";
}

function renderAgentTile(agent: AgentKind, emphasis: TileEmphasis, badgeValue?: string, actionable = false, detail?: string): string {
	if (emphasis === "quiet") {
		return svg96([
			quietDefs(),
			quietShell(),
			quietAgentIcon(agent, "main"),
			text(agent.toUpperCase(), 48, 70, 10, C.quietText, "820", "middle", 0.75),
		].join(""), `data-emphasis="quiet" data-role="agent" data-actionable="${actionable}"`);
	}
	const accent = agent === "codex" ? C.codex : C.claude;
	if (emphasis === "done" || emphasis === "error") {
		const terminalAccent = emphasis === "error" ? C.error : C.done;
		return svg96([
			defs(terminalAccent, tintFor(terminalAccent)),
			attentionHalo(terminalAccent),
			cardShell(terminalAccent),
			quietAgentIcon(agent, "main"),
			text(agent.toUpperCase(), 48, 67, 9.5, C.soft, "820", "middle", 0.75),
			text(emphasis === "error" ? "ERROR" : "DONE", 48, 79, 8.5, terminalAccent, "900", "middle", 0.7),
		].join(""), `data-emphasis="${emphasis}" data-role="agent" data-actionable="${actionable}"`);
	}
	const labelColor = "#18202C";
	const badgeFill = "#17202D";
	const badgeText = "#FFFFFF";
	const brandStops = `<stop stop-color="#FFFFFF"/><stop offset=".58" stop-color="#F2F5F8"/><stop offset="1" stop-color="#D7DEE7"/>`;
	const detailLayout = detail ? layoutText(detail, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [8.5, 8], letterSpacing: 0.55 }) : undefined;
	return svg96([
		`<defs><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">${brandStops}</linearGradient><filter id="brandShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="#000" flood-opacity=".54"/></filter></defs>`,
		clip("agentDetail", KEY_CONTENT_X, 69, KEY_CONTENT_WIDTH, 12),
		emphasis === "attention" ? attentionHalo(accent) : "",
		`<rect x="4" y="4" width="88" height="88" rx="14" fill="url(#brand)" stroke="${accent}" stroke-width="2" filter="url(#brandShadow)"/>`,
		appIcon(agent, 28, 11, 40),
		text(agent.toUpperCase(), 48, detail ? 64 : 70, 10, labelColor, "900", "middle", 0.8),
		detailLayout ? text(detailLayout.lines[0] ?? "", 48, 79, detailLayout.size, accent, "850", "middle", 0.55, 'clip-path="url(#agentDetail)"') : "",
		emphasis === "attention" && badgeValue ? badge(badgeValue, badgeFill, badgeText) : "",
	].join(""), `data-emphasis="${emphasis}" data-role="agent" data-actionable="${actionable}"`);
}

function renderQuietActionTile(model: MainTileModel): string {
	if (model.mutedDetail) {
		const detail = layoutText(model.detail ?? "—", { maxWidth: KEY_CONTENT_WIDTH, maxLines: 2, sizes: [8.6, 8.2, 8], letterSpacing: 0.25 });
		const firstDetailY = detail.lines.length === 1 ? 73.5 : 64.5;
		return svg96([
			quietDefs(),
			clip("quietDetail", KEY_CONTENT_X, 58, KEY_CONTENT_WIDTH, 22),
			quietShell(),
			lucide(model.icon ?? "circle", 37, 13, 22, C.quietIcon, 1.9),
			text(model.label, 48, 52, 10, C.quietText, "780", "middle", 0.35),
			...detail.lines.map((line, index) => text(line, 48, firstDetailY + index * detail.lineHeight, detail.size, C.muted, "720", "middle", 0.25, 'clip-path="url(#quietDetail)"')),
		].join(""), `data-emphasis="quiet" data-role="muted-status" data-actionable="${model.actionable}"`);
	}
	const label = layoutText(model.label, { maxWidth: KEY_CONTENT_WIDTH, maxLines: 1, sizes: [10.5, 10, 9.5], letterSpacing: 0.35 });
	return svg96([
		quietDefs(),
		quietShell(),
		lucide(model.icon ?? "circle", 37, 17, 22, C.quietIcon, 2),
		text(label.lines[0] ?? "", 48, 64, label.size, C.quietText, "780", "middle", 0.35),
	].join(""), `data-emphasis="quiet" data-role="action" data-actionable="${model.actionable}"`);
}

/** Rasterized frames: HID displays cannot run SVG/CSS animations. Text stays above the light. */
function diagonalSweep(accent: string, now: number): string {
	const phase = ((now % 2600) + 2600) % 2600 / 2600;
	const x = -100 + phase * 300;
	return `<defs><clipPath id="sweepClip"><rect x="5" y="5" width="86" height="86" rx="13"/></clipPath><linearGradient id="sweepLight"><stop stop-color="${accent}" stop-opacity="0"/><stop offset=".42" stop-color="${accent}" stop-opacity=".12"/><stop offset=".56" stop-color="#FFFFFF" stop-opacity=".25"/><stop offset=".7" stop-color="${accent}" stop-opacity=".12"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#sweepClip)" data-animation="diagonal-sweep"><g transform="translate(${x.toFixed(2)} 0) skewX(-24)"><rect x="0" y="5" width="52" height="86" fill="url(#sweepLight)"/></g></g>`;
}

function centerFill(progress: number, accent: string): string {
	const size = Math.max(0.5, 84 * progress);
	const x = 48 - size / 2;
	return `<rect x="${x.toFixed(2)}" y="${x.toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" rx="${Math.max(1, 12 * progress).toFixed(2)}" fill="${accent}" fill-opacity="${(0.16 + progress * 0.64).toFixed(2)}"/>`;
}

function svg96(body: string, attributes = ""): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" ${attributes}><rect width="96" height="96" fill="${C.canvas}"/>${body}</svg>`;
}

function quietDefs(): string {
	return `<defs><linearGradient id="quietSurface" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#151B23"/><stop offset=".52" stop-color="#0D1219"/><stop offset="1" stop-color="#080C12"/></linearGradient><filter id="quietShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity=".58"/></filter><filter id="monochrome" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope=".72"/><feFuncG type="linear" slope=".72"/><feFuncB type="linear" slope=".72"/></feComponentTransfer></filter></defs>`;
}

function quietShell(): string {
	return `<rect x="4" y="4" width="88" height="88" rx="14" fill="url(#quietSurface)" stroke="${C.quietRing}" stroke-width="2" filter="url(#quietShadow)"/>`;
}

function attentionHalo(accent: string): string {
	return `<rect x="2.5" y="2.5" width="91" height="91" rx="16" fill="none" stroke="${accent}" stroke-width="3" stroke-opacity=".7"/>`;
}

function defs(accent: string, tint: string): string {
	return `<defs><linearGradient id="surface" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${tint}"/><stop offset=".52" stop-color="${C.surfaceA}"/><stop offset="1" stop-color="${C.surfaceB}"/></linearGradient><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.3" flood-color="#000" flood-opacity=".62"/></filter></defs>`;
}

function cardShell(accent: string): string {
	return `<rect x="4" y="4" width="88" height="88" rx="14" fill="url(#surface)" stroke="${accent}" stroke-width="2" filter="url(#shadow)"/>`;
}

function appIcon(agent: AgentKind, x: number, y: number, size: number, attributes = ""): string {
	return `<image href="data:image/svg+xml;base64,${APP_IMAGES[agent]}" x="${x}" y="${y}" width="${size}" height="${size}" ${attributes}/>`;
}

function quietAppIcon(agent: AgentKind, x: number, y: number, size: number, opacity: number): string {
	const filter = agent === "claude" ? 'filter="url(#monochrome)"' : "";
	return `<image data-quiet-agent="${agent}" href="data:image/svg+xml;base64,${QUIET_APP_IMAGES[agent]}" x="${x}" y="${y}" width="${size}" height="${size}" opacity="${opacity}" ${filter}/>`;
}

function quietAgentIcon(agent: AgentKind, placement: "main" | "slot"): string {
	if (agent === "codex") return placement === "main" ? quietAppIcon(agent, 30, 13, 36, 0.62) : quietAppIcon(agent, 35, 35, 26, 0.45);
	return placement === "main" ? quietAppIcon(agent, 33, 16, 30, 0.4) : quietAppIcon(agent, 36, 36, 24, 0.32);
}

/** Quiet Codex uses only the supplied flower/terminal mark, never its white app-icon backdrop. */
function makeQuietCodexSvg(source: string): string {
	return source
		.replace(/<path\b(?=[^>]*fill="#fff")[^>]*><\/path>/i, "")
		.replace(/fill="url\([^\"]+\)"/i, 'fill="#8E9AA9"')
		.replace(/<defs>[\s\S]*?<\/defs>/i, "")
		.replace("<title>Codex</title>", "<title>Codex quiet</title>");
}

function lucide(name: string, x: number, y: number, size: number, color: string, strokeWidth = 2): string {
	let inner = LUCIDE_CACHE.get(name);
	if (!inner) {
		const source = fs.readFileSync(require.resolve(`lucide-static/icons/${name}.svg`), "utf8");
		inner = source.replace(/^.*?<svg[^>]*>/s, "").replace(/<\/svg>.*$/s, "");
		LUCIDE_CACHE.set(name, inner);
	}
	const scale = size / 24;
	return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}

function text(value: string, x: number, y: number, size: number, color: string, weight = "600", anchor: "start" | "middle" | "end" = "middle", spacing = 0, attributes = ""): string {
	return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${fontFamily()}" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${color}" ${attributes}>${escapeXml(value)}</text>`;
}

function clip(id: string, x: number, y: number, width: number, height: number): string {
	return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath></defs>`;
}

function badge(value: string, fill: string, textColor: string): string {
	const width = Math.max(19, 10 + value.length * 6);
	return `<rect x="${88 - width}" y="8" width="${width}" height="18" rx="9" fill="${fill}" stroke="#FFFFFF" stroke-opacity=".4"/><text x="${88 - width / 2}" y="20.2" text-anchor="middle" font-family="${fontFamily()}" font-size="8.2" font-weight="900" fill="${textColor}">${escapeXml(value)}</text>`;
}

function fontFamily(): string { return `-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',Arial,sans-serif`; }
function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char); }

type GraphemeSegmenter = { segment: (value: string) => Iterable<{ segment: string }> };
type GraphemeSegmenterConstructor = new (locales?: string | string[], options?: { granularity: "grapheme" }) => GraphemeSegmenter;
const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
const GRAPHEME_SEGMENTER = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function graphemes(value: string): string[] {
	return GRAPHEME_SEGMENTER ? [...GRAPHEME_SEGMENTER.segment(value)].map((entry) => entry.segment) : [...value];
}

export function measureText(value: string, size: number, letterSpacing = 0): number {
	const segments = graphemes(value);
	return segments.reduce((width, segment) => width + glyphWidth(segment, size), 0)
		+ Math.max(0, segments.length - 1) * letterSpacing;
}

function glyphWidth(value: string, size: number): number {
	if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}/u.test(value)) return size;
	if (/^\s+$/u.test(value)) return size * 0.32;
	if (/^[ilI1|.'`,:;!]$/u.test(value)) return size * 0.3;
	if (value === "…") return size;
	if (/^[MW@#%&]$/u.test(value)) return size * 0.9;
	if (/^[A-Z0-9]$/u.test(value)) return size * 0.72;
	if (/^[()[\]{}\-_/\\]$/u.test(value)) return size * 0.42;
	return size * 0.58;
}

export function layoutText(input: string, options: TextLayoutOptions): TextLayout {
	const normalized = input.replace(/\r\n?/g, "\n").replace(/[\t\f\v]+/g, " ").trim();
	const sizes = options.sizes.filter((size) => size >= 8);
	const candidates = sizes.length > 0 ? sizes : [8];
	const spacing = options.letterSpacing ?? 0;
	if (options.maxLines === 1) {
		const flat = normalized.replace(/\s+/g, " ");
		const singleSizes = [...new Set([...candidates, 8])];
		const width = options.maxWidth * .90;
		const size = singleSizes.find(candidate => measureText(flat, candidate, spacing) <= width) ?? 8;
		const truncated = measureText(flat, size, spacing) > width;
		const line = truncated ? ellipsize(flat, size, width, spacing) : flat;
		return {lines:[line], size, lineHeight:Math.max(10,size+2), widths:[measureText(line,size,spacing)], truncated};
	}
	for (let index = 0; index < candidates.length; index += 1) {
		const size = candidates[index]!;
		if (index < candidates.length - 1 && normalized.split(/\s+/).some(word => /^[A-Za-z0-9_-]+$/.test(word) && measureText(word, size, spacing) > options.maxWidth)) continue;
		const allLines = wrapText(normalized, size, options.maxWidth, spacing);
		const fits = allLines.length <= options.maxLines;
		if (!fits && index < candidates.length - 1) continue;
		const lines = allLines.slice(0, options.maxLines);
		const truncated = !fits;
		if (truncated && lines.length > 0) lines[lines.length - 1] = ellipsize(lines.at(-1) ?? "", size, options.maxWidth, spacing);
		return {
			lines: lines.length > 0 ? lines : [""],
			size,
			lineHeight: Math.max(10, size + 2),
			widths: (lines.length > 0 ? lines : [""]).map((line) => measureText(line, size, spacing)),
			truncated,
		};
	}
	return { lines: [""], size: 8, lineHeight: 10, widths: [0], truncated: false };
}

function wrapText(value: string, size: number, maxWidth: number, spacing: number): string[] {
	if (!value) return [""];
	const lines: string[] = [];
	for (const paragraph of value.split("\n")) {
		const words = paragraph.trim().split(/\s+/u).filter(Boolean);
		let current = "";
		for (const word of words) {
			const candidate = current ? `${current} ${word}` : word;
			if (measureText(candidate, size, spacing) <= maxWidth) {
				current = candidate;
				continue;
			}
			if (current) {
				lines.push(current);
				current = "";
			}
			const chunks = splitLongToken(word, size, maxWidth, spacing);
			if (chunks.length > 1) lines.push(...chunks.slice(0, -1));
			current = chunks.at(-1) ?? "";
		}
		if (current || words.length === 0) lines.push(current);
	}
	return lines;
}

function splitLongToken(value: string, size: number, maxWidth: number, spacing: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const segment of graphemes(value)) {
		if (current && measureText(current + segment, size, spacing) > maxWidth) {
			chunks.push(current);
			current = segment;
		}
		else current += segment;
	}
	if (current) chunks.push(current);
	return chunks.length > 0 ? chunks : [""];
}

function ellipsize(value: string, size: number, maxWidth: number, spacing: number): string {
	const segments = graphemes(value.replace(/…$/u, ""));
	while (segments.length > 0 && measureText(`${segments.join("")}…`, size, spacing) > maxWidth) segments.pop();
	return `${segments.join("")}…`;
}

function tintFor(accent: string): string {
	if (accent === C.error || accent === C.control || accent === C.reject) return "#2B0711";
	if (accent === C.approval) return "#2A1904";
	if (accent === C.input) return "#1E0D30";
	if (accent === C.done || accent === C.verify || accent === C.approve) return "#06241A";
	if (accent === C.claude) return "#32120A";
	return "#052538";
}

function statusVisual(status: TaskStatus, agent: AgentKind): { label: string; accent: string; tint: string } {
	switch (status) {
		case "RUNNING": {
			const accent = agent === "codex" ? C.codex : C.claude;
			return { label: "RUNNING", accent, tint: tintFor(accent) };
		}
		case "APPROVAL": return { label: "DECIDE", accent: C.approval, tint: "#2A1904" };
		case "NEEDS_INPUT": return { label: agent === "codex" ? "QUESTION" : "INPUT", accent: C.input, tint: "#1E0D30" };
		case "DONE_UNREAD":
		case "DONE": return { label: "DONE", accent: C.done, tint: "#06241A" };
		case "ERROR": return { label: "ERROR", accent: C.error, tint: "#2B0711" };
		case "PAUSED": return { label: "PAUSED", accent: C.approval, tint: "#2A1904" };
		case "QUEUED": return { label: "QUEUED", accent: C.muted, tint: "#111827" };
		case "STALE": return { label: "STALE", accent: C.muted, tint: "#151A24" };
		case "IDLE": return { label: "IDLE", accent: C.muted, tint: "#0B111B" };
	}
}

export const COLORS = C;

/** A physical column shares task identity; only its lower key visualizes progress. */
export function renderTaskColumnKey(task: Task, lower: boolean, durationMs = task.progress.durationMs, now = Date.now()): string {
 const running = task.status === "RUNNING";
 const waiting = task.status === "APPROVAL" || task.status === "NEEDS_INPUT";
 const color = waiting ? C.approval : task.status === "ERROR" ? C.error : task.status === "DONE" || task.status === "DONE_UNREAD" ? C.done : running ? COLORS[task.agent] : "#64748B";
 const total = Math.max(0,task.progress.todoTotal);
 const ratio = total ? Math.max(0,Math.min(1,task.progress.todoCompleted/total)) : 0;
 const label = waiting ? "REPLY" : running ? "RUNNING" : task.status === "DONE_UNREAD" ? "DONE" : task.status;
 const title = layoutText(task.titleShort || task.projectLabel,{maxWidth:64,maxLines:3,sizes:[13,12,11,10,9,8]});
 const seconds=Math.floor(Math.max(0,durationMs)/1000);
 const duration=seconds<3600 ? `${Math.floor(seconds/60)}m ${seconds%60}s` : `${Math.floor(seconds/3600)}h ${Math.floor(seconds/60)%60}m`;
 const durationLayout=layoutText(duration,{maxWidth:KEY_CONTENT_WIDTH,maxLines:1,sizes:[13,12,11,10,9,8]});
 const valueLayout=layoutText(total ? `${Math.round(ratio*100)}%` : running ? "WORKING" : "—",{maxWidth:KEY_CONTENT_WIDTH,maxLines:1,sizes:[16,14,12,10,8]});
 const statusLayout=layoutText(label,{maxWidth:KEY_CONTENT_WIDTH,maxLines:1,sizes:[8]});
 const fill = lower && running ? diagonalSweep(color, now) : "";
 return svg96(`<defs><clipPath id="columnClip"><rect x="5" y="5" width="86" height="86" rx="12"/></clipPath></defs><rect x="5" y="5" width="86" height="86" rx="12" fill="#070B12" stroke="${color}" stroke-opacity="${running || waiting ? .9 : .25}"/><g clip-path="url(#columnClip)">${fill}</g><g opacity="${running || waiting ? 1 : .5}">` +
 (lower ? text(durationLayout.lines[0]!,48,34,durationLayout.size,C.text,"800","middle")+text(valueLayout.lines[0]!,48,57,valueLayout.size,color,"800","middle") : title.lines.map((line,i)=>text(line,48,29+i*15,title.size,C.text,"800","middle")).join("")) + text(statusLayout.lines[0]!,48,80,statusLayout.size,color,"700","middle")+'</g>',`data-role="task-${lower ? "progress" : "title"}" data-task-id="${escapeXml(task.taskId)}" data-state="${task.status}" data-ratio="${ratio.toFixed(4)}"`);
}
