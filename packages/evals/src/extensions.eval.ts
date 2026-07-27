import { join } from "node:path";
import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const piExtensionsHarness = createPiCodingAgentHarness({ name: "pi-coding-agent-extensions" });

describeEval("Pi extensions", { harness: piExtensionsHarness }, (it) => {
	it("creates, reloads, and uses a hello extension", async ({ run }) => {
		const result = await run({
			steps: [
				{
					type: "prompt",
					content:
						"Create a Pi extension with a hello tool that takes a name and returns a greeting. For example, passing Bob should return `Hello, Bob!`.",
				},
				{ type: "reload" },
				{
					type: "prompt",
					content: "Use the hello tool to greet Bob. Respond with exactly the text returned by the tool.",
				},
			],
		});

		expect(result.output.trim()).toBe("Hello, Bob!");
		expect(result.errors).toEqual([]);
		expect(result.artifacts?.workspaceFiles).toContain(join(".pi", "extensions", "hello.ts"));
		expect(result.artifacts?.reloads).toEqual([
			expect.objectContaining({
				loadedExtensionCount: 1,
				activeTools: expect.arrayContaining([{ name: "hello", label: "Hello" }]),
			}),
		]);
		expect(toolCalls(result.session)).toContainEqual({
			name: "hello",
			arguments: { name: "Bob" },
			status: "ok",
			result: "Hello, Bob!",
		});
	});
});
