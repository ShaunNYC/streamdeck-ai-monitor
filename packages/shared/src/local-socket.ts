import { EventEmitter } from "node:events";

/** A paired, in-process version of the small WebSocket surface used by device IPC. */
export class LocalSocket extends EventEmitter {
	readyState = 1;
	private peer?: LocalSocket;

	static pair(): [LocalSocket, LocalSocket] {
		const server = new LocalSocket();
		const client = new LocalSocket();
		server.peer = client;
		client.peer = server;
		return [server, client];
	}

	send(data: string): void {
		if (this.readyState !== 1 || !this.peer || this.peer.readyState !== 1) throw new Error("Local IPC is closed");
		const peer = this.peer;
		queueMicrotask(() => { if (peer.readyState === 1) peer.emit("message", Buffer.from(data)); });
	}

	close(): void {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		const peer = this.peer;
		this.peer = undefined;
		this.emit("close");
		if (peer?.readyState === 1) {
			peer.peer = undefined;
			peer.readyState = 3;
			peer.emit("close");
		}
	}
}
