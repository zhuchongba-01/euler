import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/execution-env.js";
import { createAgentHarness, createSession } from "../../src/harness/factory.js";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";

describe("harness factories", () => {
	it("creates sessions from storage", async () => {
		const storage = new InMemorySessionStorage({
			metadata: { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" },
		});
		const session = createSession(storage);
		expect(session.getStorage()).toBe(storage);
		expect(await session.getMetadata()).toEqual({ id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" });
	});

	it("creates agent harnesses", () => {
		const session = createSession(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const harness = createAgentHarness({
			env,
			session,
			model: initialModel,
			systemPrompt: "You are helpful.",
			steeringMode: "all",
			followUpMode: "all",
		});
		expect(harness.env).toBe(env);
		expect(harness.agent.state.model).toBe(initialModel);
		expect(harness.steeringMode).toBe("all");
		expect(harness.followUpMode).toBe("all");
		harness.steeringMode = "one-at-a-time";
		harness.followUpMode = "one-at-a-time";
		expect(harness.agent.steeringMode).toBe("one-at-a-time");
		expect(harness.agent.followUpMode).toBe("one-at-a-time");
	});

	it("updates and reads concrete resources", async () => {
		const session = createSession(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const harness = createAgentHarness({ env, session, model });
		const skill = {
			name: "inspect",
			description: "Inspect things",
			content: "Use inspection tools.",
			filePath: "/skills/inspect/SKILL.md",
		};
		const resources = { skills: [skill], promptTemplates: [{ name: "review", content: "Review $1" }] };
		const updates: unknown[] = [];
		harness.subscribe((event) => {
			if (event.type === "resources_update") updates.push(event.resources);
		});

		await harness.setResources(resources);
		const resolved = harness.getResources();

		expect(updates).toEqual([resources]);
		expect(resolved).toEqual(resources);
		expect(resolved.skills).not.toBe(resources.skills);
		expect(resolved.promptTemplates).not.toBe(resources.promptTemplates);
	});
});
