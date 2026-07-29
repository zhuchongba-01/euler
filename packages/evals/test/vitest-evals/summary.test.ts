import { describe, expect, it } from "vitest";
import {
	formatHarnessComparisonReport,
	type HarnessObservation,
	type HarnessObservationOutcome,
	summarizeHarnessComparisons,
} from "../../src/vitest-evals/summary.ts";

type ObservationResult = "passed" | "failed" | Exclude<HarnessObservationOutcome, "scored">;

function observation(
	harness: string,
	testName: string,
	result: ObservationResult,
	metrics: Pick<HarnessObservation, "totalTokens" | "totalMs" | "estimatedCostUsd"> = {},
	harnesses: string[] = ["without-tools", "with-tools"],
): HarnessObservation {
	const base = {
		evalSet: "tool access",
		groupKey: JSON.stringify([testName, 1, 42]),
		testName,
		file: "src/tool-access.eval.ts",
		harness,
		harnesses,
		repetition: 1,
		seed: 42,
		...metrics,
	};
	if (result === "passed" || result === "failed") {
		return { ...base, outcome: "scored", score: result === "passed" ? 1 : 0 };
	}
	return { ...base, outcome: result };
}

describe("summarizeHarnessComparisons", () => {
	it("computes paired correctness lift separately from efficiency deltas", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed", {
				totalTokens: 100,
				totalMs: 1000,
				estimatedCostUsd: 0.01,
			}),
			observation("with-tools", "create", "passed", {
				totalTokens: 120,
				totalMs: 800,
				estimatedCostUsd: 0.02,
			}),
			observation("without-tools", "inspect", "passed", { totalTokens: 200 }),
			observation("with-tools", "inspect", "passed", { totalTokens: 180 }),
		]);

		expect(report.evalSets).toHaveLength(1);
		expect(report.evalSets[0]?.comparisons).toEqual([
			expect.objectContaining({
				firstHarness: "without-tools",
				secondHarness: "with-tools",
				correctness: {
					totalPairs: 2,
					eligiblePairs: 2,
					firstPassRate: 0.5,
					secondPassRate: 1,
					lift: 0.5,
					firstWins: 0,
					secondWins: 1,
					ties: 1,
				},
				totalTokens: {
					totalPairs: 2,
					eligiblePairs: 2,
					firstMean: 150,
					secondMean: 150,
					meanDelta: 0,
				},
				totalMs: {
					totalPairs: 2,
					eligiblePairs: 1,
					firstMean: 1000,
					secondMean: 800,
					meanDelta: -200,
				},
				estimatedCostUsd: {
					totalPairs: 2,
					eligiblePairs: 1,
					firstMean: 0.01,
					secondMean: 0.02,
					meanDelta: 0.01,
				},
			}),
		]);
		expect(report.diagnostics).toEqual([]);
	});

	it("reports missing observations without coercing them to failures or zero telemetry", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed"),
			observation("with-tools", "create", "passed"),
			observation("without-tools", "inspect", "passed"),
		]);
		const comparison = report.evalSets[0]?.comparisons[0];

		expect(comparison?.correctness).toEqual({
			totalPairs: 2,
			eligiblePairs: 1,
			firstPassRate: 0,
			secondPassRate: 1,
			lift: 1,
			firstWins: 0,
			secondWins: 1,
			ties: 0,
		});
		expect(comparison?.totalTokens).toEqual({
			totalPairs: 2,
			eligiblePairs: 0,
			firstMean: null,
			secondMean: null,
			meanDelta: null,
		});
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({
				testName: "inspect",
				harness: "with-tools",
				reason: "missing-observation",
			}),
		);
	});

	it("keeps identical inputs in different test files separate", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "shared", "failed"),
			observation("with-tools", "shared", "passed"),
			{ ...observation("without-tools", "shared", "passed"), file: "src/other.eval.ts" },
			{ ...observation("with-tools", "shared", "passed"), file: "src/other.eval.ts" },
		]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness).toEqual(
			expect.objectContaining({ totalPairs: 2, eligiblePairs: 2 }),
		);
		expect(report.diagnostics).toEqual([]);
	});

	it("does not score harness errors as correctness failures", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "errored", { totalTokens: 100 }),
			observation("with-tools", "create", "passed", { totalTokens: 100 }),
		]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness).toEqual(
			expect.objectContaining({ totalPairs: 1, eligiblePairs: 0 }),
		);
		expect(report.evalSets[0]?.comparisons[0]?.totalTokens.eligiblePairs).toBe(0);
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({ harness: "without-tools", reason: "harness-error" }),
		);
	});

	it("does not derive correctness from completed Vitest tests without judge scores", () => {
		const withoutScore = observation("without-tools", "create", "unscored");
		const withScore = observation("with-tools", "create", "unscored");

		const report = summarizeHarnessComparisons([withoutScore, withScore]);

		expect(report.evalSets[0]?.comparisons[0]?.correctness.eligiblePairs).toBe(0);
		expect(report.diagnostics).toEqual([
			expect.objectContaining({ harness: "with-tools", reason: "missing-score" }),
			expect.objectContaining({ harness: "without-tools", reason: "missing-score" }),
		]);
	});

	it("creates every pair in declared harness order", () => {
		const harnesses = ["first", "second", "third"];
		const report = summarizeHarnessComparisons([
			observation("first", "input", "passed", {}, harnesses),
			observation("second", "input", "passed", {}, harnesses),
			observation("third", "input", "passed", {}, harnesses),
		]);

		expect(
			report.evalSets[0]?.comparisons.map(({ firstHarness, secondHarness }) => [firstHarness, secondHarness]),
		).toEqual([
			["first", "second"],
			["first", "third"],
			["second", "third"],
		]);
	});

	it("retains a declared harness with no completed observations", () => {
		const report = summarizeHarnessComparisons([observation("without-tools", "create", "failed")]);

		expect(report.evalSets[0]?.comparisons).toHaveLength(1);
		expect(report.evalSets[0]?.comparisons[0]?.correctness.eligiblePairs).toBe(0);
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({
				testName: "create",
				harness: "with-tools",
				reason: "missing-observation",
			}),
		);
	});

	it("reports duplicate and unscorable observations once across multiple harness pairs", () => {
		const harnesses = ["first", "second", "third"];
		const report = summarizeHarnessComparisons([
			observation("first", "duplicate", "passed", {}, harnesses),
			observation("first", "duplicate", "failed", {}, harnesses),
			observation("second", "duplicate", "passed", {}, harnesses),
			observation("third", "duplicate", "passed", {}, harnesses),
			observation("first", "skipped", "skipped", {}, harnesses),
			observation("second", "skipped", "passed", {}, harnesses),
			observation("third", "skipped", "passed", {}, harnesses),
		]);

		expect(report.diagnostics.filter(({ reason }) => reason === "duplicate-observation")).toEqual([
			expect.objectContaining({ testName: "duplicate", harness: "first" }),
		]);
		expect(report.diagnostics.filter(({ reason }) => reason === "unscorable-outcome")).toEqual([
			expect.objectContaining({ testName: "skipped", harness: "first" }),
		]);
	});

	it("formats lift and telemetry availability for the terminal report", () => {
		const report = summarizeHarnessComparisons([
			observation("without-tools", "create", "failed"),
			observation("with-tools", "create", "passed"),
		]);

		expect(formatHarnessComparisonReport(report)).toContain("with-tools vs without-tools");
		expect(formatHarnessComparisonReport(report)).toContain("lift +100.0 pp");
		expect(formatHarnessComparisonReport(report)).toContain("Tokens       unavailable (0/1 pairs)");
	});
});
