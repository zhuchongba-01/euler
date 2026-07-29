import { afterAll, describe, expect, it } from "vitest";
import { createHarness, describeEval } from "vitest-evals";
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
	});

	it("rejects non-JSON and circular input", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => deriveEvalGroupKey(new Date(0), 1, 42)).toThrow("only plain objects and arrays");
		expect(() => deriveEvalGroupKey(Array(1), 1, 42)).toThrow("must be JSON-serializable");
		expect(() => deriveEvalGroupKey(circular, 1, 42)).toThrow("must not contain circular references");
	});
});

const observations: Array<{
	harness: string;
	inputId: string;
	repetition: number;
	plannedOrder: number;
}> = [];

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

const harnessTable = evalHarnessTable(
	"local multi-harness eval",
	[createFakeHarness("withoutSkill"), createFakeHarness("withSkill")],
	{ repetitions: 2, seed: 42 },
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness, repetition: plannedRepetition }) => {
	describeEval("local multi-harness eval", { harness }, (it) => {
		it.for([{ id: "first" }, { id: "second" }])("$id", async ({ id }, { run }) => {
			const result = await run({ id });
			const runMetadata = parseEvalHarnessIterationArtifact(result.artifacts?.[EVAL_HARNESS_ITERATION_ARTIFACT]);

			expect(result.output.inputId).toBe(id);
			expect(runMetadata).toEqual({
				schemaVersion: 1,
				evalSet: "local multi-harness eval",
				groupKey: deriveEvalGroupKey({ id }, plannedRepetition, 42),
				harness: result.output.harness,
				harnesses: ["withoutSkill", "withSkill"],
				repetition: plannedRepetition,
				seed: 42,
				plannedOrder: expect.any(Number),
			});
			if (!runMetadata) throw new TypeError("Expected typed harness-iteration metadata.");
			const { harness: harnessName, repetition, plannedOrder } = runMetadata;
			observations.push({ harness: harnessName, inputId: id, repetition, plannedOrder });
		});
	});
});

afterAll(() => {
	expect(observations).toHaveLength(8);
	for (const inputId of ["first", "second"]) {
		for (const repetition of [1, 2]) {
			expect(
				observations
					.filter((observation) => observation.inputId === inputId && observation.repetition === repetition)
					.map((observation) => observation.harness)
					.sort(),
			).toEqual(["withSkill", "withoutSkill"]);
		}
	}
	expect(
		[...new Set(observations.map((observation) => observation.plannedOrder))].sort((left, right) => left - right),
	).toEqual([1, 2, 3, 4]);
});
