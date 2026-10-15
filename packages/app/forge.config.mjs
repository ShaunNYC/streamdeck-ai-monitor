import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version;
const buildVersion = packageVersion.replace(/-beta\.(\d+)$/, ".$1");
const adHocSigning = process.env.MAC_ADHOC_SIGN === "1";
const signingIdentity = adHocSigning ? "-" : process.env.APPLE_SIGNING_IDENTITY;
const hasNotaryCredentials = Boolean(
	(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
	|| (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
);

const osxSign = signingIdentity ? {
	identity: signingIdentity,
	// "-" creates a complete local Ad-hoc seal without claiming a Developer ID.
	// Identity lookup and secure timestamps only apply to certificate-backed releases.
	identityValidation: !adHocSigning,
	optionsForFile: () => ({
		entitlements: path.join(directory, "entitlements.plist"),
		hardenedRuntime: !adHocSigning,
		timestamp: adHocSigning ? "none" : undefined,
	}),
} : undefined;

const osxNotarize = !hasNotaryCredentials ? undefined
	: process.env.APPLE_API_KEY
		? {
			appleApiKey: process.env.APPLE_API_KEY,
			appleApiKeyId: process.env.APPLE_API_KEY_ID,
			appleApiIssuer: process.env.APPLE_API_ISSUER,
		}
		: {
			appleId: process.env.APPLE_ID,
			appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
			teamId: process.env.APPLE_TEAM_ID,
		};

const config = {
	packagerConfig: {
		name: "Agent Pulse",
		executableName: "Agent Pulse",
		appBundleId: "com.shaun-wang.streamdeck-ai-supervisor",
		buildVersion,
		appCategoryType: "public.app-category.utilities",
		appCopyright: "Copyright © 2026 Doonutsaur Games LLC",
		// Sharp's native module loads libvips with dyld, so the complete @img
		// runtime (not only the .node file) must exist outside app.asar.
		asar: { unpack: "**/node_modules/@img/**/*" },
		icon: path.join(directory, "assets", "app-icon"),
			extendInfo: {
				CFBundleDevelopmentRegion: "en",
				CFBundleLocalizations: ["en"],
				LSMinimumSystemVersion: "13.0",
				LSUIElement: true,
			NSAppTransportSecurity: {
				NSAllowsArbitraryLoads: false,
				NSAllowsLocalNetworking: true,
			},
		},
		extraResource: [
			path.resolve(directory, "..", "..", "LICENSE"),
			path.resolve(directory, "..", "..", "THIRD_PARTY_NOTICES.md"),
			path.resolve(directory, "..", "..", "PRIVACY.md"),
			path.join(directory, "build-native"),
		],
		osxSign,
		osxNotarize,
		ignore: [
			/^\/src($|\/)/,
			/^\/out($|\/)/,
			/^\/scripts($|\/)/,
			/^\/assets($|\/)/,
			/^\/package-lock\.json$/,
			/^\/(?:\.env(?:\..*)?|config\.json|state\.json|mode\.json|managed-codex\.json|token|.*\.log)$/i,
			/^\/vite\..*\.ts$/,
			/^\/tsconfig\.json$/,
		],
	},
	makers: [{
		name: "@electron-forge/maker-dmg",
		config: {
			// Finder aliases inside a DMG require a volume label no longer than 27 bytes.
			// The release script applies the full versioned filename after Forge finishes.
			name: "Agent Pulse",
			format: "ULFO",
		},
	}],
	plugins: [{ name: "@electron-forge/plugin-auto-unpack-natives", config: {} }],
};

export default process.env.AGENT_PULSE_MAS === "1"
	? (await import("./forge.mas.config.mjs")).createMasConfig(config)
	: config;
