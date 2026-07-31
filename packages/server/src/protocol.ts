import {
	type ImageContent as AiImageContent,
	type TextContent as AiTextContent,
	type Usage as AiUsage,
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	ThinkingLevel,
	ToolTranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

type Assert<T extends true> = T;
type _AiThinkingLevelsFitProtocol = Assert<ModelThinkingLevel extends ThinkingLevel ? true : false>;
type _ProtocolThinkingLevelsFitAi = Assert<ThinkingLevel extends ModelThinkingLevel ? true : false>;
type AiModelInput = Model<Api>["input"][number];
type ProtocolModelInput = ModelMetadata["input"][number];
type _AiModelInputsFitProtocol = Assert<AiModelInput extends ProtocolModelInput ? true : false>;
type _ProtocolModelInputsFitAi = Assert<ProtocolModelInput extends AiModelInput ? true : false>;

export interface AssistantTranscriptOptions {
	id: string;
}

export interface UserTranscriptOptions {
	id: string;
}

export interface ToolCallMetadata {
	toolName: string;
	input: JsonValue;
}

export interface ToolTranscriptOptions {
	id: string;
	call: ToolCallMetadata;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function timestamp(value: number): number {
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

/** Validate and copy a value from an execution boundary into the protocol's JSON-compatible subset. */
export function toProtocolJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Protocol JSON numbers must be finite");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported protocol JSON value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Protocol JSON values must not contain circular references");
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Protocol JSON objects must be plain objects");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => toProtocolJsonValue(entry, seen));
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toProtocolJsonValue(entry, seen);
		return result;
	} finally {
		seen.delete(value);
	}
}

/** Lossily sanitize diagnostic tool details that must not affect execution semantics. */
export function sanitizeProtocolDetails(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => sanitizeProtocolDetails(entry, seen) ?? null);
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalized = sanitizeProtocolDetails(entry, seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

export function toProtocolUsage(usage: AiUsage | undefined): Usage | undefined {
	if (!usage) return undefined;
	const reasoning = nonNegativeInteger(usage.reasoning);
	const result = {
		input: nonNegativeInteger(usage.input) ?? 0,
		output: nonNegativeInteger(usage.output) ?? 0,
		cacheRead: nonNegativeInteger(usage.cacheRead) ?? 0,
		cacheWrite: nonNegativeInteger(usage.cacheWrite) ?? 0,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: nonNegativeInteger(usage.totalTokens) ?? 0,
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	} satisfies Usage;
	return result;
}

export function toProtocolModelMetadata(model: Model<Api>, authenticated: boolean): ModelMetadata {
	const result = {
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated,
	} satisfies ModelMetadata;
	return result;
}

function toProtocolUserContent(content: UserMessage["content"]): UserTranscriptItem["content"] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((part) =>
		part.type === "image"
			? { type: "image", data: part.data, mimeType: part.mimeType }
			: { type: "text", text: part.text },
	);
}

export function toProtocolUserMessage(message: UserMessage, options: UserTranscriptOptions): UserTranscriptItem {
	const result = {
		id: options.id,
		role: "user",
		content: toProtocolUserContent(message.content),
		timestamp: timestamp(message.timestamp),
	} satisfies UserTranscriptItem;
	return result;
}

function toProtocolAssistantContent(message: AssistantMessage): AssistantTranscriptItem["content"] {
	return message.content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "thinking":
				return {
					type: "thinking",
					thinking: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				};
			case "toolCall":
				return {
					type: "toolCall",
					toolCallId: part.id || `tool-${message.timestamp}`,
					toolName: part.name || "unknown",
					input: toProtocolJsonValue(part.arguments),
				};
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

function toProtocolStopReason(
	stopReason: AssistantMessage["stopReason"],
): AssistantTranscriptItem["stopReason"] | undefined {
	switch (stopReason) {
		case "pending":
			return undefined;
		case "stop":
		case "length":
		case "toolUse":
		case "error":
		case "aborted":
			return stopReason;
		default: {
			const exhaustive: never = stopReason;
			return exhaustive;
		}
	}
}

export function toProtocolAssistantMessage(
	message: AssistantMessage,
	options: AssistantTranscriptOptions,
): AssistantTranscriptItem {
	const streaming = message.stopReason === "pending";
	const stopReason = streaming ? undefined : toProtocolStopReason(message.stopReason);
	const usage = toProtocolUsage(message.usage);
	const result = {
		id: options.id,
		role: "assistant",
		content: toProtocolAssistantContent(message),
		status: streaming
			? "streaming"
			: message.stopReason === "error"
				? "error"
				: message.stopReason === "aborted"
					? "aborted"
					: "complete",
		model: { provider: message.provider, id: message.model },
		...(message.responseModel ? { responseModel: message.responseModel } : {}),
		...(usage ? { usage } : {}),
		...(stopReason ? { stopReason } : {}),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		timestamp: timestamp(message.timestamp),
	} satisfies AssistantTranscriptItem;
	return result;
}

function toProtocolToolContent(content: Array<AiTextContent | AiImageContent>): ToolTranscriptItem["content"] {
	return content.map((part) =>
		part.type === "image"
			? { type: "image", data: part.data, mimeType: part.mimeType }
			: { type: "text", text: part.text },
	);
}

export function toProtocolToolResultMessage(
	message: ToolResultMessage,
	options: ToolTranscriptOptions,
): ToolTranscriptItem {
	const details = sanitizeProtocolDetails(message.details);
	const usage = toProtocolUsage(message.usage);
	const result = {
		id: options.id,
		role: "tool",
		toolCallId: message.toolCallId || `tool-${message.timestamp}`,
		toolName: options.call.toolName,
		input: options.call.input,
		content: toProtocolToolContent(message.content),
		...(details === undefined ? {} : { details }),
		status: message.isError ? "error" : "complete",
		isError: message.isError,
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	} satisfies ToolTranscriptItem;
	return result;
}
