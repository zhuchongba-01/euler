import type {
	Command,
	ModelRef,
	ResultForCommand,
	ServerEvent,
	SessionSnapshot,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { Unsubscribe } from "./types.ts";

type SessionCommand = Extract<Command, { sessionId: string }>;

export interface SessionClientOperations {
	isAttached(): boolean;
	getSnapshot(): SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
}

export class PiSessionClient {
	readonly id: string;
	readonly #operations: SessionClientOperations;

	/** @internal Construct session handles through `PiClient`. */
	constructor(id: string, operations: SessionClientOperations) {
		this.id = id;
		this.#operations = operations;
	}

	get attached(): boolean {
		return this.#operations.isAttached();
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.#operations.getSnapshot();
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#operations.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#operations.onEvent(listener);
	}

	async detach(): Promise<void> {
		await this.#request({ command: "detach", sessionId: this.id });
	}

	async prompt(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "prompt", sessionId: this.id, text })).session;
	}

	async steer(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "steer", sessionId: this.id, text })).session;
	}

	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#operations.request(command);
	}
}
