import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "packages", "app", "dist", "renderer", "index.html");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const output = process.env.AI_CONTROL_SUPERVISOR_VISUAL_OUTPUT
	?? path.join(root, "artifacts", "ui-qa-liquid-glass", "mock-screens");

if (!fs.existsSync(renderer)) throw new Error("Desktop renderer is missing. Run the renderer build first.");
if (!fs.existsSync(chrome)) throw new Error("Google Chrome is required for desktop visual QA.");
fs.mkdirSync(output, { recursive: true });

const now = Date.now();
const capabilities = (desktop = {}) => ({
	device: { open: true, review: false, verify: false, answerChoice: false },
	desktop: { open: true, send: false, approve: false, reject: false, interrupt: false, review: false, verify: false, changeSettings: false, ...desktop },
});
const running = {
	taskId: "mock-running", agent: "codex", ownership: "managed", externalId: "thread-running", executionId: "turn-running",
	projectId: "supervisor", projectLabel: "SUPERVISOR", cwd: "/Users/demo/AI Control Supervisor", titleShort: "整理桌面交互与状态映射",
	status: "RUNNING", attentionCount: 0, capabilities: capabilities({ send: true, interrupt: true, changeSettings: true }),
	progress: { latestActivity: { category: "file", label: "正在更新 Renderer", state: "running", at: now }, todoCompleted: 3, todoTotal: 5, currentTodo: "检查小窗口布局", activeSubagents: 1, totalSubagents: 2, turnStartedAt: now - 754_000, durationMs: 754_000, queueLength: 0, queueFailed: 0 },
	openRef: { kind: "url", value: "codex://threads/mock-running" }, source: "mock", lastEventAt: now, startedAt: now - 754_000,
};
const approval = {
	taskId: "mock-approval", agent: "claude", ownership: "observer", externalId: "session-approval", executionId: "turn-approval",
	projectId: "marketing", projectLabel: "MARKETING", cwd: "/Users/demo/Marketing Site", titleShort: "发布营销站点预览",
	status: "APPROVAL", attentionCount: 1, attentionVersion: 1, acknowledgedAttentionVersion: 0,
	request: { requestId: "request-approval-7f64b2", type: "network", target: "npm run deploy:preview", riskTier: 2, createdAt: now - 30_000, expiresAt: now + 600_000, decisionPath: "claude-hook" },
	capabilities: capabilities({ approve: true, reject: true, interrupt: true }),
	progress: { latestActivity: { category: "shell", label: "等待执行发布命令", state: "waiting", at: now - 30_000 }, todoCompleted: 4, todoTotal: 5, currentTodo: "部署预览", activeSubagents: 0, totalSubagents: 1, turnStartedAt: now - 221_000, durationMs: 221_000, queueLength: 0, queueFailed: 0 },
	openRef: { kind: "url", value: "claude://session/mock-approval" }, source: "mock", lastEventAt: now - 30_000, startedAt: now - 221_000,
};
const done = {
	taskId: "mock-done", agent: "codex", ownership: "observer", externalId: "thread-done",
	projectId: "ios", projectLabel: "IOS APP", cwd: "/Users/demo/iOS App", titleShort: "修复登录状态回归",
	status: "DONE", attentionCount: 0, capabilities: capabilities(),
	progress: { latestActivity: { category: "terminal", label: "测试已通过", state: "done", at: now - 180_000 }, todoCompleted: 4, todoTotal: 4, activeSubagents: 0, totalSubagents: 0, durationMs: 482_000, queueLength: 0, queueFailed: 0, recap: "已修复冷启动后的会话恢复问题，并通过现有回归测试。" },
	openRef: { kind: "url", value: "codex://threads/mock-done" }, source: "mock", lastEventAt: now - 180_000, startedAt: now - 662_000,
};
const config = {
	version: 2,
	projects: [
		{ id: "supervisor", label: "SUPERVISOR", cwd: "/Users/demo/AI Control Supervisor", verify: { command: "npm test", cwd: "/Users/demo/AI Control Supervisor", timeoutMs: 180000 } },
		{ id: "marketing", label: "MARKETING", cwd: "/Users/demo/Marketing Site" },
	],
	agents: { codex: { enabled: true }, claude: { enabled: true } },
	device: { mode: "ai", serialNumber: "CL12345678", startAtLogin: true, showInMenuBar: true },
};
const status = {
	version: JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version, platformSupported: true, inApplicationsFolder: true, configured: true, runtimeRunning: true, openAtLogin: true, elgatoRunning: false,
	desktopIntegration: { menuBar: { requested: true, state: "VISIBLE", imageLoaded: true }, dock: { state: "VISIBLE", windowVisible: true } },
	agents: {
		codex: { enabled: true, detected: true, health: "OK", detail: "Codex Desktop 已连接", runningCount: 1, decisionCount: 0 },
		claude: { enabled: true, detected: true, health: "OK", detail: "Claude Desktop 已连接", runningCount: 0, decisionCount: 1 },
	},
	codexApprovalControl: { status: "READY", lastCheckedAt: now, permissionKind: "post-event", provider: "native-main-process", bundleId: "com.shaun-wang.streamdeck-ai-supervisor" },
	device: { state: "CONNECTED", devices: [{ model: "Stream Deck Neo", path: "mock-neo", serialNumber: "CL12345678" }], scannedDevices: [{ model: "Stream Deck Neo", path: "mock-neo", serialNumber: "CL12345678" }], selectedSerialNumber: "CL12345678", productName: "Stream Deck Neo" },
	config, tasks: [running, approval, done], managedDetails: [{ task: running, model: "gpt-5.6", queue: [], requests: [] }],
};

for (const [index, size] of [[820, 660], [940, 760], [940, 920]].entries()) {
	await captureSize(size[0], size[1], 17860 + index);
}

console.log("[desktop-liquid-glass-visual] Settings, history navigation and takeover rollback verified at 820x660 and 940x760: ok");

async function captureSize(width, height, port) {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-liquid-glass-"));
	const browser = childProcess.spawn(chrome, [
		"--headless=new", "--allow-file-access-from-files", "--disable-background-networking", "--hide-scrollbars",
		"--no-first-run", "--no-default-browser-check", "--disable-component-update", "--disable-extensions",
		`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
	], { cwd: root, stdio: "ignore" });
	try {
		const page = await waitForPage(port);
		const cdp = await createCdp(page.webSocketDebuggerUrl);
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bridgeSource(status) });
		await cdp.send("Page.navigate", { url: pathToFileURL(renderer).href });
		await waitForRenderer(cdp);
		await assertNoHorizontalOverflow(cdp, `${width}x${height} Settings`);
		await assertExpression(cdp, "!document.getElementById('view-tasks') && document.querySelectorAll('#usage-total').length === 1 && document.querySelectorAll('[data-day]').length > 0", "Settings-only summary did not render");
		await assertExpression(cdp, "document.querySelector('.settings-heading').nextElementSibling?.classList.contains('usage-panel')", "Summary must be first");
		await screenshot(cdp, path.join(output, `${width}x${height}-settings.png`));
        await assertExpression(cdp, "document.getElementById('usage-total').textContent.endsWith('s')", "Day summary includes seconds");
        await cdp.send("Runtime.evaluate", {expression:"document.querySelector('[data-day=\"2026-09-10\"]').click();document.querySelector('[data-day=\"2026-09-10\"]').focus();window.__calendarFocus=document.activeElement;window.__calendarScroll=document.getElementById('content-scroll').scrollTop"});
        await assertExpression(cdp,"document.getElementById('usage-total').textContent==='18h 00m 00s'", "Selected day changes the top total");
        await cdp.send("Runtime.evaluate", {expression:"window.__mockStatus.monitor.days['2026-09-10'].codex+=1000"});
        await delay(1200);
        await assertExpression(cdp,"document.getElementById('usage-total').textContent==='18h 00m 01s'", "Live data refresh updates the selected day");
        await assertExpression(cdp,"document.activeElement === window.__calendarFocus && document.activeElement.dataset.day==='2026-09-10' && document.getElementById('content-scroll').scrollTop===window.__calendarScroll", "Refresh preserves selected day, focus and scroll");
        await cdp.send("Runtime.evaluate", {expression:"document.querySelector('[data-usage-agent=claude]').click()"});
        await assertExpression(cdp,"document.getElementById('usage-summary-label').textContent.startsWith('Claude')", "Agent switch changes only inspected data");
        await cdp.send("Runtime.evaluate", {expression:"document.querySelector('[data-usage-agent=codex]').click();document.getElementById('usage-today').click()"});
        for (const period of ['week','month','year']) {
            await cdp.send("Runtime.evaluate", {expression:`document.querySelector('[data-period=${period}]').click()`});
            await assertExpression(cdp,"!document.getElementById('usage-total').textContent.endsWith('s')", "Other summary periods never show seconds");
            await assertExpression(cdp, "[...document.querySelectorAll('.usage-value')].every(e=>e.scrollWidth<=e.clientWidth)", "Calendar values must fit their cells");
            if(period==='year') await assertExpression(cdp,"document.querySelectorAll('.usage-year .usage-cell').length===12 && !document.getElementById('usage-calendar').textContent.includes('m') && !document.getElementById('usage-total').textContent.includes('m')", "Year uses hours throughout");
            await screenshot(cdp, path.join(output, `${width}x${height}-${period}.png`));
        }
        await cdp.send("Runtime.evaluate", {expression:"document.querySelector('[data-period=day]').click()"});
        await assertExpression(cdp,"[...document.querySelectorAll('[data-day]')].filter(e=>e.dataset.day>'2026-09-18').every(e=>e.disabled && e.querySelector('.usage-value').textContent==='—')", "Future days have no usage");
		await cdp.send("Runtime.evaluate", {expression:"document.getElementById('usage-prev').click()"});
		await assertExpression(cdp,"!document.getElementById('usage-next').disabled", "Previous period must be navigable");
		await cdp.send("Runtime.evaluate", {expression:"document.querySelector('[data-period=week]').click()"});
		await assertExpression(cdp,"document.getElementById('usage-next').disabled", "Period switch returns to current week");
		await cdp.send("Runtime.evaluate", {expression:"window.__modeFailure=true;document.getElementById('takeover-toggle').click()"});
		await delay(200);
		await assertExpression(cdp,"document.getElementById('takeover-toggle').checked && !document.getElementById('confirm-sheet').open", "Failed switch must restore actual mode without a confirmation sheet");
		await cdp.send("Runtime.evaluate", {expression:"window.__modeFailure=false;document.getElementById('takeover-toggle').click()"});
		await delay(200);
		await assertExpression(cdp,"!document.getElementById('takeover-toggle').checked", "Successful switch must reflect saved mode");

        const fixturesPath=path.join(root,'artifacts/calendar-layout/device/fixtures.json');
        if(fs.existsSync(fixturesPath)) {
            const fixtures=JSON.parse(fs.readFileSync(fixturesPath,'utf8'));
            const measurement=await cdp.send('Runtime.evaluate',{expression:`(async()=>{
                await document.fonts.ready;
                const host=document.createElement('div');host.style.cssText='position:fixed;left:-10000px;top:0';document.body.append(host);
                const failures=[];
                for(const fixture of ${JSON.stringify(fixtures)}) {
                    host.innerHTML=fixture.svg;
                    for(const text of host.querySelectorAll('text')) {
                        const b=text.getBBox();
                        if(b.width && (b.x<11 || b.x+b.width>85 || b.y<9 || b.y+b.height>85)) failures.push({name:fixture.name,text:text.textContent,x:b.x,y:b.y,width:b.width,height:b.height});
                        const clip=text.getAttribute('clip-path')?.match(/#([^)]*)/);
                        if(clip) {const r=host.querySelector('#'+clip[1]+' rect');if(r) {
                            const x=+r.getAttribute('x'),y=+r.getAttribute('y'),w=+r.getAttribute('width'),h=+r.getAttribute('height');
                            if(b.x<x-.5 || b.x+b.width>x+w+.5 || b.y<y-.5 || b.y+b.height>y+h+.5) failures.push({name:fixture.name,text:text.textContent,clipped:true,x:b.x,y:b.y,width:b.width,height:b.height});
                        }}
                    }
                }
                host.remove();return failures;
            })()`,awaitPromise:true,returnByValue:true});
            assert.deepEqual(measurement.result.value,[], 'Actual font bounds must fit key margins and clipping areas');
        }
		cdp.close();
	} finally {
		browser.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => browser.once("exit", resolve)),
			delay(1_000),
		]);
		fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

function bridgeSource(mockStatus) {
	return `{
		const mockStatus = ${JSON.stringify(mockStatus)};
        const RealDate=Date, fixed=new RealDate(2026,8,18,12,0,0).getTime();
        window.Date=class extends RealDate {constructor(...args){if(args.length)super(...args);else super(fixed);}static now(){return fixed;}};
        const days={};const hours=[0,2,4,6,8,10,12,14,16,18,22,5,7,3,9,4,6,3.4291667];
        for(let i=1;i<=18;i++) days['2026-09-'+String(i).padStart(2,'0')]={codex:Math.floor(hours[i-1]*3600000),claude:Math.floor(hours[18-i]*1800000)};
        mockStatus.monitor={selectedAgent:'codex',days,slots:{codex:[],claude:[]}};
		const ok = async () => ({ ok: true, message: "操作成功" });
		window.__bridgeCalls = [];
		window.__mockStatus = mockStatus;
		Object.defineProperty(window, "supervisor", { configurable: true, value: {
			getStatus: async () => structuredClone(mockStatus), chooseProject: async () => null,
			saveSettings: ok, setMode: async mode => { if(window.__modeFailure) return {ok:false,message:"设备暂不可用"}; mockStatus.config.device.mode=mode; return {ok:true,message:"已切换"}; }, runDiagnostics: ok, requestCodexApprovalPermission: ok,
			repairCodexApprovalPermission: ok, rebuildMenuBarIcon: ok, removeIntegration: ok,
			deleteDesktopTasks: ok, clearDesktopTaskHistory: ok,
			sendManagedMessage: async () => mockStatus.managedDetails[0], retryManagedMessage: async () => mockStatus.managedDetails[0],
			updateManagedSettings: ok, interruptTask: ok,
			decideRequest: async (...args) => { window.__bridgeCalls.push({ name: "decideRequest", args }); return window.__decisionResult ?? { ok: true, message: "操作成功" }; },
			answerRequest: async (...args) => { window.__bridgeCalls.push({ name: "answerRequest", args }); return { ok: true, message: "回答已发送" }; },
			openAgent: ok, openTask: ok,
		} });
	}`;
}

async function waitForPage(port) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
			const page = pages.find((candidate) => candidate.type === "page" && !candidate.url.startsWith("chrome-extension://"));
			if (page?.webSocketDebuggerUrl) return page;
		} catch { /* Chrome is still starting. */ }
		await delay(50);
	}
	throw new Error(`Chrome DevTools did not start on port ${port}`);
}

async function createCdp(url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
	});
	return {
		send(method, params = {}) {
			const messageId = ++id;
			return new Promise((resolve, reject) => {
				pending.set(messageId, { resolve, reject });
				socket.send(JSON.stringify({ id: messageId, method, params }));
			});
		},
		close() { socket.close(); },
	};
}

async function assertNoHorizontalOverflow(cdp, label) {
	const result = await cdp.send("Runtime.evaluate", {
		expression: "({ document: document.documentElement.scrollWidth <= innerWidth, content: document.getElementById('content-scroll').scrollWidth <= document.getElementById('content-scroll').clientWidth })",
		returnByValue: true,
	});
	if (!result.result.value) throw new Error(`${label} could not be measured: ${JSON.stringify(result)}`);
	assert.deepEqual(result.result.value, { document: true, content: true }, `${label} has horizontal overflow`);
}

async function assertExpression(cdp, expression, message) {
	const result = await cdp.send("Runtime.evaluate", { expression: `Boolean(${expression})`, returnByValue: true });
	assert.equal(result.result.value, true, message);
}

async function waitForRenderer(cdp) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await cdp.send("Runtime.evaluate", { expression: "Boolean(document.getElementById('content-scroll'))", returnByValue: true });
		if (result.result.value === true) {
			await delay(250);
			return;
		}
		await delay(50);
	}
	const detail = await cdp.send("Runtime.evaluate", { expression: "({ href: location.href, readyState: document.readyState, title: document.title })", returnByValue: true });
	throw new Error(`Desktop renderer did not load: ${JSON.stringify(detail)}`);
}

async function screenshot(cdp, file) {
	const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
	fs.writeFileSync(file, Buffer.from(result.data, "base64"));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
