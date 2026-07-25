import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	type JsonValue,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
} from "vitest-evals/harness";

type EvalSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
type EvalMessage = EvalSession["messages"][number];

type PiCodingAgentHarnessOptions = {
	name?: string;
	noTools?: "all" | "builtin";
	run?: (args: {
		input: string;
		cwd: string;
		session: EvalSession;
		prompt: (input: string) => Promise<string>;
	}) => Promise<string>;
};

function getRequiredModelSelection(): { provider: string; model: string } {
	const provider = process.env.PI_PROVIDER?.trim();
	const model = process.env.PI_MODEL?.trim();
	if (!provider || !model) throw new Error("PI_PROVIDER and PI_MODEL must both be set for eval runs.");
	return { provider, model };
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part !== null &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function jsonRecord(value: unknown): Record<string, JsonValue> | undefined {
	const json = toJsonValue(value);
	return json !== null && typeof json === "object" && !Array.isArray(json) ? json : undefined;
}

function transcriptEvents(messages: EvalMessage[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: textContent(message.content) });
		} else if (message.role === "assistant") {
			const text = textContent(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type === "toolCall") {
					events.push({
						type: "tool_call",
						id: part.id,
						name: part.name,
						arguments: jsonRecord(part.arguments),
					});
				}
			}
		} else if (message.role === "toolResult") {
			const content = textContent(message.content) || toJsonValue(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content,
				...(message.isError ? { error: { message: textContent(message.content) || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function prompt(session: EvalSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	signal?.throwIfAborted();
	await session.prompt(input);
	const assistant = session.messages
		.slice()
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Pi eval did not produce an assistant message.");
	if (assistant.stopReason !== "stop") {
		throw new Error(assistant.errorMessage ?? `Pi eval stopped unexpectedly: ${assistant.stopReason}`);
	}
	const output = session.getLastAssistantText();
	if (!output) throw new Error("Pi eval produced an empty assistant response.");
	return output;
}

async function runPiCodingAgent(
	input: string,
	signal: AbortSignal | undefined,
	options: PiCodingAgentHarnessOptions,
): Promise<SimpleHarnessResult<string>> {
	signal?.throwIfAborted();
	const selection = getRequiredModelSelection();
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(selection.provider, selection.model);
	if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.model}`);

	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	let session: EvalSession | undefined;
	try {
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
		});
		signal?.throwIfAborted();
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				thinkingLevel: "off",
				noTools: options.noTools,
			})
		).session;

		const evalSession = session;
		const abort = () => void evalSession.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const sendPrompt = (promptInput: string) => prompt(evalSession, promptInput, signal);
			const output = options.run
				? await options.run({ input, cwd, session: evalSession, prompt: sendPrompt })
				: await sendPrompt(input);
			const stats = evalSession.getSessionStats();
			return {
				output,
				events: transcriptEvents(evalSession.messages),
				usage: {
					provider: model.provider,
					model: model.id,
					inputTokens: stats.tokens.input,
					outputTokens: stats.tokens.output,
					totalTokens: stats.tokens.total,
					toolCalls: stats.toolCalls,
				},
			};
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	} finally {
		try {
			session?.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

export function createPiCodingAgentHarness(options: PiCodingAgentHarnessOptions = {}) {
	return createHarness<string, string>({
		name: options.name ?? "pi-coding-agent",
		run: ({ input, signal }) => runPiCodingAgent(input, signal, options),
	});
}
