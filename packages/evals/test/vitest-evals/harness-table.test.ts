import { describe, expect, it } from "vitest";
import { createHarness, type HarnessContext } from "vitest-evals/harness";
import {
	deriveEvalGroupKey,
	EVAL_HARNESS_ITERATION_ARTIFACT,
	evalHarnessTable,
	parseEvalHarnessIterationArtifact,
} from "../../src/vitest-evals/harness-table.ts";

describe("deriveEvalGroupKey", () => {
	it("combines a trimmed string input ID with repetition and seed", () => {
		expect(deriveEvalGroupKey({ id: " input-1 ", prompt: "hello" }, 2, 42)).toBe(JSON.stringify(["input-1", 2, 42]));
	});

	it("hashes canonical JSON independently of object key order", () => {
		expect(deriveEvalGroupKey({ first: 1, second: [true, "value"] }, 1, 42)).toBe(
			deriveEvalGroupKey({ second: [true, "value"], first: 1 }, 1, 42),
		);
		expect(deriveEvalGroupKey({ first: 1 }, 1, 42)).not.toBe(deriveEvalGroupKey({ first: 2 }, 1, 42));
		expect(deriveEvalGroupKey({ first: 1 }, 1, 42)).not.toBe(deriveEvalGroupKey({ first: 1 }, 2, 42));
		expect(deriveEvalGroupKey(["first", "second"], 1, 42)).not.toBe(deriveEvalGroupKey(["second", "first"], 1, 42));
	});

	it("rejects non-JSON and circular input", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => deriveEvalGroupKey(new Date(0), 1, 42)).toThrow("only plain objects and arrays");
		expect(() => deriveEvalGroupKey(Array(1), 1, 42)).toThrow("must not be sparse");
		expect(() => deriveEvalGroupKey(circular, 1, 42)).toThrow("must not contain circular references");
	});
});

function createFakeHarness(name: string) {
	return createHarness<{ id: string }, { harness: string; inputId: string }>({
		name,
		run: ({ input }) => ({
			output: { harness: name, inputId: input.id },
			events: [
				{ type: "message", role: "user", content: input.id },
				{ type: "message", role: "assistant", content: name },
			],
		}),
	});
}

const harnessTable = evalHarnessTable("local multi-harness eval", {
	baseline: createFakeHarness("withoutSkill"),
	candidates: [createFakeHarness("withSkill")],
	repetitions: 2,
	seed: 42,
});

describe("evalHarnessTable", () => {
	it("plans seeded repetitions in deterministic order", () => {
		expect(
			harnessTable.map(({ name, repetition, seed, plannedOrder }) => ({ name, repetition, seed, plannedOrder })),
		).toEqual([
			{ name: "withoutSkill", repetition: 1, seed: 42, plannedOrder: 1 },
			{ name: "withSkill", repetition: 1, seed: 42, plannedOrder: 2 },
			{ name: "withSkill", repetition: 2, seed: 42, plannedOrder: 3 },
			{ name: "withoutSkill", repetition: 2, seed: 42, plannedOrder: 4 },
		]);
	});

	it("accepts a singular candidate", () => {
		const rows = evalHarnessTable("singular candidate", {
			baseline: createFakeHarness("baseline"),
			candidate: createFakeHarness("candidate"),
			seed: 42,
		});

		expect(rows.map(({ name }) => name)).toEqual(["baseline", "candidate"]);
	});

	it("attaches iteration metadata to every wrapped harness run", async () => {
		for (const row of harnessTable) {
			const artifacts: HarnessContext["artifacts"] = {};
			const context: HarnessContext = {
				artifacts,
				setArtifact(name, value) {
					artifacts[name] = value;
				},
			};
			const result = await row.harness.run({ id: "first" }, context);

			expect(result.output).toEqual({ harness: row.name, inputId: "first" });
			expect(parseEvalHarnessIterationArtifact(result.artifacts?.[EVAL_HARNESS_ITERATION_ARTIFACT])).toEqual({
				schemaVersion: 1,
				evalSet: "local multi-harness eval",
				groupKey: deriveEvalGroupKey({ id: "first" }, row.repetition, 42),
				harness: row.name,
				baseline: "withoutSkill",
				candidates: ["withSkill"],
				repetition: row.repetition,
				seed: 42,
				plannedOrder: row.plannedOrder,
			});
		}
	});
});
