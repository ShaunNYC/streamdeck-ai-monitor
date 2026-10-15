import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expected = "Rain falls on the windowsill like a note from night to morning.";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sentencePath = path.join(repositoryRoot, "verify-demo", "rain-sentence.txt");
const actual = fs.readFileSync(sentencePath, "utf8").trim();

console.log(`[rain-verify] Expected: ${expected}`);
console.log(`[rain-verify] Actual:   ${actual}`);
console.log("[rain-verify] Checking for 6 seconds so the Stream Deck RUNNING state remains visible...");

await new Promise((resolve) => setTimeout(resolve, 6_000));

if (actual !== expected) {
	console.error("[rain-verify] FAIL: the generated sentence does not match the expected sentence.");
	process.exitCode = 1;
} else {
	console.log("[rain-verify] PASS: the generated sentence matches exactly.");
}
