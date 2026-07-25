import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
} from "vitest-evals/harness";

type PiCodingAgentHarnessOptions = {
	name?: string;
	noTools?: CreateAgentSessionOptions["noTools"];
	run?: (args: {
		input: string;
		cwd: string;
		session: AgentSession;
		prompt: (input: string) => Promise<string>;
	}) => Promise<string>;
};

function getRequiredModelSelection(): { provider: string; model: string } {
	const provider = process.env.PI_PROVIDER?.trim();
	const model = process.env.PI_MODEL?.trim();
	if (!provider || !model) throw new Error("PI_PROVIDER and PI_MODEL must both be set for eval runs.");
	return { provider, model };
}

function toTranscriptEvents(messages: AgentSession["messages"]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
		} else if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type === "toolCall") {
					events.push({
						type: "tool_call",
						id: part.id,
						name: part.name,
						arguments: normalizeRecord(part.arguments),
					});
				}
			}
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: text || toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	signal?.throwIfAborted();
	const previousMessageCount = session.messages.length;
	await session.prompt(input);
	const assistant = session.messages
		.slice(previousMessageCount)
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
	let session: AgentSession | undefined;
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
			signal?.throwIfAborted();
			const sendPrompt = (promptInput: string) => promptAgent(evalSession, promptInput, signal);
			const output = options.run
				? await options.run({ input, cwd, session: evalSession, prompt: sendPrompt })
				: await sendPrompt(input);
			const stats = evalSession.getSessionStats();
			return {
				output,
				events: toTranscriptEvents(evalSession.messages),
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
