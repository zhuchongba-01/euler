import type { ModelRef, ServerEvent, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { SessionClientHost, Unsubscribe } from "./types.ts";

export class PiSessionClient {
	readonly id: string;
	private readonly client: SessionClientHost;

	constructor(client: SessionClientHost, id: string) {
		this.client = client;
		this.id = id;
	}

	get attached(): boolean {
		return this.client.isSessionAttached(this.id);
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.client.getSessionSnapshot(this.id);
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.client.subscribeSession(this.id, listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.client.onSessionEvent(this.id, listener);
	}

	async detach(): Promise<void> {
		this.client.assertAttached(this.id);
		await this.client.detachSession(this.id);
	}

	async prompt(text: string): Promise<SessionSnapshot> {
		this.client.assertAttached(this.id);
		const result = await this.client.request({ command: "prompt", sessionId: this.id, text });
		return result.session;
	}

	async steer(text: string): Promise<SessionSnapshot> {
		this.client.assertAttached(this.id);
		const result = await this.client.request({ command: "steer", sessionId: this.id, text });
		return result.session;
	}

	async abort(): Promise<SessionSnapshot> {
		this.client.assertAttached(this.id);
		const result = await this.client.request({ command: "abort", sessionId: this.id });
		return result.session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		this.client.assertAttached(this.id);
		const result = await this.client.request({ command: "set_model", sessionId: this.id, model });
		return result.session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		this.client.assertAttached(this.id);
		const result = await this.client.request({ command: "set_thinking", sessionId: this.id, thinkingLevel });
		return result.session;
	}
}
