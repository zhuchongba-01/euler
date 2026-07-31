import type { Api, AssistantMessage, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { encodeServerMessage, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "../src/protocol.ts";

const model = {
	id: "model-1",
	name: "Model One",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} satisfies Model<Api>;

type ProtocolTranscriptItem =
	| ReturnType<typeof toProtocolAssistantMessage>
	| ReturnType<typeof toProtocolUserMessage>
	| ReturnType<typeof toProtocolToolResultMessage>;

function assertValidServerPayload(item: ProtocolTranscriptItem): void {
	expect(() =>
		encodeServerMessage({
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: "connection-1",
			snapshot: {
				serverId: "server-1",
				protocolVersion: PROTOCOL_VERSION,
				revision: 0,
				sessions: [
					{
						id: "session-1",
						cwd: "/workspace",
						createdAt: 1,
						updatedAt: 1,
						phase: "idle",
						model: { provider: "test-provider", id: "model-1" },
						thinkingLevel: "off",
						attached: true,
						locked: true,
					},
				],
				models: [toProtocolModelMetadata(model, true)],
			},
		}),
	).not.toThrow();

	expect(() =>
		encodeServerMessage({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: {
					id: "session-1",
					cwd: "/workspace",
					createdAt: 1,
					updatedAt: 1,
					phase: "idle",
					model: { provider: "test-provider", id: "model-1" },
					thinkingLevel: "off",
					attached: true,
					locked: true,
					revision: 1,
					transcript: [item],
					queuedSteer: [],
					queuedSteerCount: 0,
				},
			},
		}),
	).not.toThrow();
}

describe("pi-ai protocol bridge", () => {
	test("maps model metadata and produces protocol-valid output", () => {
		const result = toProtocolModelMetadata(model, true);

		expect(result).toMatchObject({
			provider: "test-provider",
			id: "model-1",
			api: "test-api",
			input: ["text", "image"],
			authenticated: true,
		});
		expect(result.supportedThinkingLevels).toContain("off");
	});

	test("exhaustively maps assistant content and stop reasons", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hmm", redacted: false },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			},
			stopReason: "toolUse",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-1" });

		expect(result).toMatchObject({
			id: "message-1",
			status: "complete",
			stopReason: "toolUse",
			model: { provider: "test-provider", id: "model-1" },
		});
		expect(result.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "hmm", redacted: false },
			{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } },
		]);
		assertValidServerPayload(result);
	});

	test("maps user and tool messages without leaking non-JSON details", () => {
		const user = {
			role: "user",
			content: "hello",
			timestamp: 1,
		} satisfies UserMessage;
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const tool = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: circular,
			isError: false,
			timestamp: 2,
		} satisfies ToolResultMessage;

		const userResult = toProtocolUserMessage(user, { id: "user-1" });
		expect(userResult).toMatchObject({
			id: "user-1",
			content: [{ type: "text", text: "hello" }],
		});
		assertValidServerPayload(userResult);

		const toolResult = toProtocolToolResultMessage(tool, {
			id: "tool-1",
			call: { toolName: "read", input: { path: "README.md" } },
		});
		expect(toolResult).toMatchObject({
			id: "tool-1",
			toolName: "read",
			input: { path: "README.md" },
			details: { self: "[Circular]" },
			status: "complete",
		});
		assertValidServerPayload(toolResult);
	});

	test("derives streaming status from a pending stop reason", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-pending" });
		expect(result).toMatchObject({ status: "streaming" });
		expect(result).not.toHaveProperty("stopReason");
		assertValidServerPayload(result);
	});

	test("rejects lossy tool input conversions", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => toProtocolJsonValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(1n)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(undefined)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(circular)).toThrow(TypeError);
	});
});
