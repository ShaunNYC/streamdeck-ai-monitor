import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMasConfig } from '../packages/app/forge.mas.config.mjs';
import base from '../packages/app/forge.config.mjs';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pulse-mas-config-'));
try {
 delete process.env.MAS_PROVISIONING_PROFILE;
 assert.throws(() => createMasConfig(base), /MAS_PROVISIONING_PROFILE/);
 process.env.MAS_PROVISIONING_PROFILE = path.join(temporary, 'profile');
 fs.writeFileSync(process.env.MAS_PROVISIONING_PROFILE, 'test profile placeholder');
 process.env.MAS_SIGNING_IDENTITY = 'Developer ID Application: Example';
 process.env.MAS_BUILD_NUMBER = '33011';
 assert.throws(() => createMasConfig(base), /MAS_SIGNING_IDENTITY/);
 process.env.MAS_SIGNING_IDENTITY = 'Apple Distribution: Example (TEAM)';
 process.env.MAS_BUILD_NUMBER = '3.3.0-beta.11';
 assert.throws(() => createMasConfig(base), /MAS_BUILD_NUMBER/);
 process.env.MAS_BUILD_NUMBER = '33011';
 const result = createMasConfig(base);
 assert.equal(result.packagerConfig.platform, 'mas');
 assert.equal(result.packagerConfig.buildVersion, '33011');
 assert.equal(result.packagerConfig.appVersion, '3.3.1');
 assert.equal(result.packagerConfig.osxSign.type, 'distribution');
 assert.equal(result.packagerConfig.osxNotarize, undefined);
 assert.ok(result.packagerConfig.extraResource.every(value => !value.endsWith('build-native')));
 for (const file of ['/build-native/macos-control.node', '/native/macos-control.mm']) {
  assert.ok(result.packagerConfig.ignore.some(pattern => pattern.test(file)), 'MAS archive must exclude cross-app keyboard control binaries and sources');
  assert.ok(!base.packagerConfig.ignore.some(pattern => pattern.test(file)), 'Independent packaging keeps its existing native module behavior');
 }
 const options = result.packagerConfig.osxSign.optionsForFile;
 assert.ok(options('/tmp/Agent Pulse.app').entitlements.endsWith('/entitlements.mas.plist'));
 assert.ok(options('/tmp/Agent Pulse.app/Contents/Frameworks/Agent Pulse Helper.app').entitlements.endsWith('/entitlements.mas.inherit.plist'));
 const mainEntitlements = fs.readFileSync(options('/tmp/Agent Pulse.app').entitlements, 'utf8');
 assert.doesNotMatch(mainEntitlements, /com\.apple\.security\.network\.server/);
 assert.match(mainEntitlements, /com\.apple\.security\.network\.client/);
 assert.equal(base.packagerConfig.platform, undefined, 'Independent build remains unchanged');
 // Execute the actual packaging hook: preserve the loader's runtime binding,
 // remove compiler intermediates that can contain local paths, fail if missing.
 const hidBuild = path.join(temporary, 'node_modules/node-hid/build');
 fs.mkdirSync(path.join(hidBuild, 'Release/obj.target'), { recursive: true });
 const runtime = Buffer.from('synthetic native runtime');
 fs.writeFileSync(path.join(hidBuild, 'Release/HID.node'), runtime);
 fs.writeFileSync(path.join(hidBuild, 'Makefile'), '/Users/private-builder/source');
 fs.writeFileSync(path.join(hidBuild, 'Release/obj.target/HID.o'), '/Users/private-builder/source');
 const prune = result.packagerConfig.afterPrune.at(-1);
 await new Promise((resolve, reject) => prune(temporary, '', 'mas', 'arm64', error => error ? reject(error) : resolve()));
 assert.deepEqual(fs.readdirSync(hidBuild), ['Release']);
 assert.deepEqual(fs.readdirSync(path.join(hidBuild, 'Release')), ['HID.node']);
 assert.deepEqual(fs.readFileSync(path.join(hidBuild, 'Release/HID.node')), runtime);
 assert.equal(base.packagerConfig.afterPrune, undefined);
 fs.rmSync(path.join(hidBuild, 'Release/HID.node'));
 await assert.rejects(new Promise((resolve, reject) => prune(temporary, '', 'mas', 'arm64', error => error ? reject(error) : resolve())));
 process.env.MAS_SIGNING_IDENTITY = 'Apple Development: Example (TEAM)';
 assert.equal(createMasConfig(base).packagerConfig.osxSign.type, 'development');
 console.log('MAS build configuration regression passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
