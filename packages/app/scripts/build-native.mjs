#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(appRoot, "native", "macos-control.mm");
const destinationDirectory = path.join(appRoot, "build-native");
const destination = path.join(destinationDirectory, "macos-control.node");
const nodeInclude = path.resolve(path.dirname(process.execPath), "..", "include", "node");

if (process.platform !== "darwin") throw new Error("The macOS control module can only be built on macOS.");
if (process.arch !== "arm64") throw new Error(`The beta build requires arm64, got ${process.arch}.`);
if (!fs.existsSync(path.join(nodeInclude, "node_api.h"))) throw new Error(`Node-API headers are missing: ${nodeInclude}`);
fs.mkdirSync(destinationDirectory, { recursive: true });
childProcess.execFileSync("/usr/bin/xcrun", [
	"clang++", "-std=c++20", "-ObjC++", "-fobjc-arc", "-dynamiclib", "-undefined", "dynamic_lookup",
	"-arch", "arm64", "-mmacosx-version-min=13.0", `-I${nodeInclude}`,
	"-framework", "AppKit", "-framework", "CoreGraphics", source, "-o", destination,
], { stdio: "inherit" });
console.log(destination);
