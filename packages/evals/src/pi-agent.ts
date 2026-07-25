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
import type { PiAiEventSink, PiAiRuntime, PiAiToolset } from "./pi-harness.ts";

type EvalSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
type EvalRuntime = PiAiRuntime<PiAiToolset<string>, string>;

type PiEvalAgentOptions = {
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
	if (!provider || !model) {
		throw new Error("PI_PROVIDER and PI_MODEL must both be set for eval runs.");
	}
	return { provider, model };
}

async function promptPi(
	session: EvalSession,
	input: string,
	signal: AbortSignal | undefined,
	events: PiAiEventSink,
	recordUser: boolean,
): Promise<string> {
	signal?.throwIfAborted();
	if (recordUser) events.user(input);
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
	events.assistant(output);
	return output;
}

export async function createPiEvalAgent(options: PiEvalAgentOptions, signal: AbortSignal | undefined) {
	signal?.throwIfAborted();
	const selection = getRequiredModelSelection();
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel(selection.provider, selection.model);
	if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.model}`);

	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	let session: EvalSession | undefined;
	const cleanup = async () => {
		try {
			session?.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};

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
	} catch (error) {
		await cleanup();
		throw error;
	}

	const evalSession = session;
	return {
		agent: evalSession.agent,
		async run(input: string, runtime: EvalRuntime) {
			const abort = () => void evalSession.abort();
			let promptCount = 0;
			runtime.signal?.addEventListener("abort", abort, { once: true });
			try {
				const prompt = (promptInput: string) => {
					const recordUser = promptCount > 0;
					promptCount++;
					return promptPi(evalSession, promptInput, runtime.signal, runtime.events, recordUser);
				};
				const output = options.run
					? await options.run({ input, cwd, session: evalSession, prompt })
					: await prompt(input);
				const stats = evalSession.getSessionStats();
				return {
					output,
					metrics: {
						provider: model.provider,
						model: model.id,
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						totalTokens: stats.tokens.total,
						toolCalls: stats.toolCalls,
					},
				};
			} finally {
				runtime.signal?.removeEventListener("abort", abort);
				await cleanup();
			}
		},
	};
}
