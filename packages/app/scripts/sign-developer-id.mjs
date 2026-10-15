import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAsync } from '@electron/osx-sign';
const app=process.argv[2];
const identity=process.env.APPLE_SIGNING_IDENTITY;
if(!app?.endsWith('.app') || !identity?.startsWith('Developer ID Application:')) throw new Error('Supply an app and Developer ID Application identity.');
await signAsync({app:path.resolve(app),identity,identityValidation:true,optionsForFile:()=>({entitlements:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../entitlements.plist'),hardenedRuntime:true})});
