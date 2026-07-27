import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const piExtensionsHarness = createPiCodingAgentHarness({
	name: "pi-coding-agent-extensions",
	output: async ({ response, session }) => {
		const extensionPath = join(session.sessionManager.getCwd(), ".pi", "extensions", "hello.ts");
		const extensionCreated = await stat(extensionPath).then(
			(file) => file.isFile(),
			() => false,
		);
		return {
			response,
			extensionCreated,
			loadedExtensionCount: session.extensionRunner.getExtensionPaths().length,
			helloToolLabel: session.getToolDefinition("hello")?.label ?? null,
		};
	},
});

describeEval("Pi extensions", { harness: piExtensionsHarness }, (it) => {
	it("creates, reloads, and uses a hello extension", async ({ run }) => {
		const result = await run([
			{
				type: "prompt",
				content:
					"Create a Pi extension with a hello tool that takes a name and returns a greeting. For example, passing Bob should return `Hello, Bob!`.",
			},
			{ type: "reload" },
			{
				type: "prompt",
				content: "Use the hello tool to greet Bob.",
			},
		]);

		expect(result.output).toEqual({
			response: "Hello, Bob!",
			extensionCreated: true,
			loadedExtensionCount: 1,
			helloToolLabel: "Hello",
		});
		expect(result.errors).toEqual([]);
		expect(toolCalls(result.session)).toContainEqual({
			name: "hello",
			arguments: { name: "Bob" },
			status: "ok",
			result: "Hello, Bob!",
		});
	});
});
