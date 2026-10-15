const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTHORIZATION)(?:_|$)/i;

/**
 * Redacts common local credentials before text can reach the device, logs, or
 * a diagnostics archive. The patterns intentionally prefer false positives to
 * leaking a usable credential.
 */
export function redactSensitiveText(value: string): string {
	return value
		.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_CREDENTIAL]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
		.replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_TOKEN]")
		.replace(/((?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|credentials?)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi, "$1[REDACTED]");
}

/** Removes secret-bearing variables from commands configured by the user. */
export function sanitizeEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	return Object.fromEntries(Object.entries(environment).flatMap(([name, value]): Array<[string, string]> => (
		value !== undefined && !SENSITIVE_ENVIRONMENT_NAME.test(name) ? [[name, value]] : []
	)));
}

export function isSensitiveEnvironmentName(name: string): boolean {
	return SENSITIVE_ENVIRONMENT_NAME.test(name);
}
