import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 2 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

export const ModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("tool_call"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
export const UserContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
export type TextContent = Static<typeof TextContentSchema>;
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
export type ImageContent = Static<typeof ImageContentSchema>;
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
export type Usage = Static<typeof UsageSchema>;

export const UserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
export const AssistantTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	status: Type.Union([
		Type.Literal("streaming"),
		Type.Literal("complete"),
		Type.Literal("error"),
		Type.Literal("aborted"),
	]),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	stopReason: Type.Optional(
		Type.Union([
			Type.Literal("stop"),
			Type.Literal("length"),
			Type.Literal("tool_use"),
			Type.Literal("error"),
			Type.Literal("aborted"),
		]),
	),
	errorMessage: Type.Optional(Type.String()),
	timestamp: TimestampSchema,
});
export const ToolTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	status: Type.Union([Type.Literal("running"), Type.Literal("complete"), Type.Literal("error")]),
	isError: Type.Boolean(),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
});
export const TranscriptItemSchema = Type.Union([
	UserTranscriptItemSchema,
	AssistantTranscriptItemSchema,
	ToolTranscriptItemSchema,
]);
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** Normalized incremental activity. Snapshots remain authoritative. */
export const TranscriptProgressSchema = Type.Union([
	StrictObject({
		type: Type.Literal("item_started"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		type: Type.Literal("assistant_delta"),
		messageId: IdSchema,
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("tool_call")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("item_updated"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
	StrictObject({
		type: Type.Literal("item_finished"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
]);
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

const SessionSummaryProperties = {
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
} as const;

export const SessionSummarySchema = StrictObject(SessionSummaryProperties);
export const SessionSnapshotSchema = StrictObject({
	...SessionSummaryProperties,
	revision: Type.Integer({ minimum: 0 }),
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
});
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ServerSnapshotSchema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionSummarySchema),
	models: Type.Array(ModelMetadataSchema),
});
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("auth"),
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;
