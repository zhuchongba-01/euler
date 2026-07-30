import type {
	Command,
	CommandResult,
	ModelRef,
	ResultForCommand,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConnectionStateChange {
	state: ConnectionState;
	error?: Error;
}

export type Unsubscribe = () => void;

export interface PiClientOptions {
	token: string;
	transportFactory: ByteTransportFactory;
	maxFrameLength?: number;
}

export interface CreateSessionOptions {
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export interface SessionClientHost {
	isSessionAttached(sessionId: string): boolean;
	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined;
	detachSession(sessionId: string): Promise<void>;
	request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>>;
	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe;
	assertAttached(sessionId: string): void;
}

export interface PendingRequest {
	command: Command;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export type ServerSnapshotListener = (snapshot: ServerSnapshot) => void;
