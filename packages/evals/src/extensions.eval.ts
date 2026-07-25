import assert from "node:assert";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const createHelloExtensionPrompt =
	"Create a Pi extension with a hello tool that takes a name and returns a greeting. For example, passing Bob should return `Hello, Bob!`.";

const piExtensionsHarness = createPiCodingAgentHarness({
	name: "pi-coding-agent-extensions",
	run: async ({ input, cwd, prompt, session }) => {
		assert.strictEqual(
			session.extensionRunner.getExtensionPaths().length,
			0,
			"Expected no extensions before creation",
		);
		await prompt(input);
		const extensionPath = join(cwd, ".pi", "extensions", "hello.ts");
		const extensionCreated = await stat(extensionPath).then(
			(file) => file.isFile(),
			() => false,
		);
		if (!extensionCreated) throw new Error(`Extension was not created at ${extensionPath}`);

		await session.reload();
		assert.strictEqual(session.extensionRunner.getExtensionPaths().length, 1, "Expected one extension after reload");
		if (!session.getActiveToolNames().includes("hello")) {
			throw new Error("Extension tool 'hello' was not loaded");
		}
		if (session.getToolDefinition("hello")?.label !== "Hello") {
			throw new Error("Extension tool 'hello' did not have label 'Hello'");
		}

		return prompt("Use the hello tool to greet Bob. Respond with exactly the text returned by the tool.");
	},
});

describeEval("Pi extensions", { harness: piExtensionsHarness }, (it) => {
	it("creates, reloads, and uses a hello extension", async ({ run }) => {
		const result = await run(createHelloExtensionPrompt);

		expect(result.output.trim()).toBe("Hello, Bob!");
		expect(result.errors).toEqual([]);
	});
});
