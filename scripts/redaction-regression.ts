import assert from "node:assert/strict";
import { redactSensitiveText, sanitizeEnvironment } from "@streamdeck-supervisor/shared";
import { parseClaudeHookEvent } from "../packages/daemon/src/adapters/claude-events.ts";
import { safeTaskTitle } from "../packages/daemon/src/adapters/types.ts";

const secrets = [
	"sk-" + "proj-1234567890abcdefghijklmnopqrstuvwxyz",
	"sk-" + "ant-1234567890abcdefghijklmnopqrstuvwxyz",
	"ghp_" + "1234567890abcdefghijklmnopqrstuvwxyz",
	"Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk.abcdefghijklmnop",
	"api_key=super-secret-value-1234567890",
	"-----BE" + "GIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
];
const redacted = redactSensitiveText(secrets.join("\n"));
for (const secret of secrets.slice(0, 3)) assert.equal(redacted.includes(secret), false);
assert.match(redacted, /REDACTED/);

const environment = sanitizeEnvironment({
	PATH: "/usr/bin:/bin",
	NO_COLOR: "1",
	OPENAI_API_KEY: "secret",
	GITHUB_TOKEN: "secret",
	DATABASE_PASSWORD: "secret",
	PRIVATE_KEY_FILE: "/tmp/key",
	AWS_CREDENTIAL: "secret",
});
assert.deepEqual(environment, { PATH: "/usr/bin:/bin", NO_COLOR: "1" });

const title = safeTaskTitle(`Deploy with ${secrets[0]}`, "Task");
assert.equal(title.includes("sk-proj"), false, "Task titles must be redacted before reaching the device");
const hook = parseClaudeHookEvent({
	session_id: "security-test",
	cwd: "/tmp/security-test",
	hook_event_name: "PermissionRequest",
	tool_name: "Bash",
	tool_input: { command: `curl -H 'Authorization: Bearer ${secrets[0]}' https://example.test` },
}, "blocking");
assert.ok(hook?.request);
assert.equal(hook.request.target.includes(secrets[0]), false, "Approval targets must not expose credentials");
assert.equal(hook.task.titleShort.includes(secrets[0]), false);

console.log("[redaction] task titles, approval targets, credentials, private keys and verification environments: ok");
