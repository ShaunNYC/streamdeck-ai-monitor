import { DeviceController } from "./device-controller.js";
import { daemonClient } from "./daemon-client.js";

const controller = new DeviceController();

async function shutdown(signal: string): Promise<void> {
	console.log(`[device] ${signal}; shutting down`);
	daemonClient.stop();
	await controller.stop();
	process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => console.error("[device] uncaught exception", error));
process.on("unhandledRejection", (error) => console.error("[device] unhandled rejection", error));

daemonClient.start();
await controller.start();
