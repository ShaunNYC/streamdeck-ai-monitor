import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const directory = path.dirname(fileURLToPath(import.meta.url));

// Forge rebuilds node-hid after copying it. Remove its build-time paths and
// object files after that rebuild, before archiving/signing the application.
export function pruneMasHidBuild(buildPath, _version, _platform, _arch, done) {
	try {
		const build = path.join(buildPath, "node_modules", "node-hid", "build");
		if (!fs.statSync(path.join(build, "Release", "HID.node")).isFile()) throw new Error("MAS HID runtime is missing");
		for (const entry of fs.readdirSync(build)) {
			if (entry === "Release") {
				for (const file of fs.readdirSync(path.join(build, entry))) {
					if (file !== "HID.node") fs.rmSync(path.join(build, entry, file), { recursive: true, force: true });
				}
			} else fs.rmSync(path.join(build, entry), { recursive: true, force: true });
		}
		done();
	} catch (error) { done(error); }
}

export function createMasConfig(base) {
	const profile = process.env.MAS_PROVISIONING_PROFILE;
	const identity = process.env.MAS_SIGNING_IDENTITY;
	const buildVersion = process.env.MAS_BUILD_NUMBER;
	if (!profile || !fs.statSync(profile).isFile()) throw new Error("MAS_PROVISIONING_PROFILE must point to an Apple provisioning profile.");
	if (!identity || !/^(Apple Development|Apple Distribution|3rd Party Mac Developer Application|Mac Developer):/.test(identity)) {
		throw new Error("MAS_SIGNING_IDENTITY must be an Apple development or Mac App Store distribution identity.");
	}
	if (!buildVersion || !/^[1-9]\d{0,8}$/.test(buildVersion)) throw new Error("MAS_BUILD_NUMBER must be a positive numeric build number.");
	const development = /^(Apple Development|Mac Developer):/.test(identity);

	return {
		...base,
		packagerConfig: {
			...base.packagerConfig,
			platform: "mas",
			appVersion: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version.split("-")[0],
			buildVersion,
			appCategoryType: "public.app-category.developer-tools",
			extendInfo: { ...base.packagerConfig.extendInfo, ElectronTeamID: "64D92WRFF6" },
			extraResource: base.packagerConfig.extraResource.filter(resource => !resource.endsWith("build-native")),
			ignore: [...base.packagerConfig.ignore, /^\/(?:build-native|native)($|\/)/],
			afterPrune: [...(base.packagerConfig.afterPrune ?? []), pruneMasHidBuild],
			osxNotarize: undefined,
			osxSign: {
				identity,
				platform: "mas",
				type: development ? "development" : "distribution",
				provisioningProfile: profile,
				optionsForFile: (filePath) => ({
					entitlements: path.join(directory, filePath.endsWith("Agent Pulse.app") ? "entitlements.mas.plist" : "entitlements.mas.inherit.plist"),
					hardenedRuntime: false,
				}),
			},
		},
		// The upload PKG must be built separately with Mac Installer Distribution.
		makers: [],
	};
}
