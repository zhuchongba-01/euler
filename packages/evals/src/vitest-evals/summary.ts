type HarnessObservationOutcome = "scored" | "unscored" | "skipped" | "pending" | "errored";

type HarnessObservationBase = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	harness: string;
	harnesses: string[];
	repetition: number;
	seed: number;
	totalTokens?: number;
	totalMs?: number;
	estimatedCostUsd?: number;
};

export type HarnessObservation = HarnessObservationBase &
	({ outcome: "scored"; score: number } | { outcome: Exclude<HarnessObservationOutcome, "scored">; score?: never });

export type PairedMetricSummary = {
	totalPairs: number;
	eligiblePairs: number;
	firstMean: number | null;
	secondMean: number | null;
	meanDelta: number | null;
};

export type CorrectnessLiftSummary = {
	totalPairs: number;
	eligiblePairs: number;
	firstPassRate: number | null;
	secondPassRate: number | null;
	lift: number | null;
	firstWins: number;
	secondWins: number;
	ties: number;
};

export type HarnessPairComparison = {
	firstHarness: string;
	secondHarness: string;
	correctness: CorrectnessLiftSummary;
	totalTokens: PairedMetricSummary;
	totalMs: PairedMetricSummary;
	estimatedCostUsd: PairedMetricSummary;
};

export type HarnessComparisonDiagnostic = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	repetition: number;
	seed: number;
	harness: string;
	reason: "missing-observation" | "duplicate-observation" | "harness-error" | "missing-score" | "unscorable-outcome";
};

export type HarnessEvalSetReport = {
	evalSet: string;
	comparisons: HarnessPairComparison[];
};

export type HarnessComparisonReport = {
	schemaVersion: 1;
	evalSets: HarnessEvalSetReport[];
	diagnostics: HarnessComparisonDiagnostic[];
};

type HarnessDescriptor = {
	name: string;
	index: number;
};

type ObservationGroup = {
	evalSet: string;
	groupKey: string;
	testName: string;
	file: string;
	repetition: number;
	seed: number;
	observationsByHarness: Map<string, HarnessObservation[]>;
};

type EvalSetData = {
	harnessesByName: Map<string, HarnessDescriptor>;
	groupsByKey: Map<string, ObservationGroup>;
};

type ObservationPair = {
	first: HarnessObservation;
	second: HarnessObservation;
};

function getOrCreate<K, V extends object>(map: Map<K, V>, key: K, create: () => V): V {
	const existing = map.get(key);
	if (existing !== undefined) return existing;
	const value = create();
	map.set(key, value);
	return value;
}

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function preciseDifference(left: number, right: number): number {
	return Number((left - right).toPrecision(15));
}

function allPairs<T>(values: readonly T[]): Array<[T, T]> {
	const pairs: Array<[T, T]> = [];
	for (let first = 0; first < values.length; first += 1) {
		for (let second = first + 1; second < values.length; second += 1) {
			pairs.push([values[first], values[second]]);
		}
	}
	return pairs;
}

function groupObservations(observations: readonly HarnessObservation[]): Map<string, EvalSetData> {
	const evalSets = new Map<string, EvalSetData>();
	for (const observation of observations) {
		const evalSet = getOrCreate(evalSets, observation.evalSet, () => ({
			harnessesByName: new Map(),
			groupsByKey: new Map(),
		}));

		for (const [index, name] of observation.harnesses.entries()) {
			const existing = evalSet.harnessesByName.get(name);
			if (!existing || index < existing.index) evalSet.harnessesByName.set(name, { name, index });
		}

		const group = getOrCreate(
			evalSet.groupsByKey,
			JSON.stringify([observation.file, observation.testName, observation.groupKey]),
			() => ({
				evalSet: observation.evalSet,
				groupKey: observation.groupKey,
				testName: observation.testName,
				file: observation.file,
				repetition: observation.repetition,
				seed: observation.seed,
				observationsByHarness: new Map(),
			}),
		);
		getOrCreate(group.observationsByHarness, observation.harness, (): HarnessObservation[] => []).push(observation);
	}
	return evalSets;
}

function orderedHarnesses(evalSet: EvalSetData): HarnessDescriptor[] {
	return [...evalSet.harnessesByName.values()].sort(
		(left, right) => left.index - right.index || left.name.localeCompare(right.name),
	);
}

function orderedGroups(evalSet: EvalSetData): ObservationGroup[] {
	return [...evalSet.groupsByKey.values()].sort(
		(left, right) =>
			left.groupKey.localeCompare(right.groupKey) || left.repetition - right.repetition || left.seed - right.seed,
	);
}

function collectDiagnostics(
	harnesses: readonly HarnessDescriptor[],
	groups: readonly ObservationGroup[],
): HarnessComparisonDiagnostic[] {
	const diagnostics: HarnessComparisonDiagnostic[] = [];
	for (const group of groups) {
		for (const { name: harness } of harnesses) {
			const observations = group.observationsByHarness.get(harness) ?? [];
			let reason: HarnessComparisonDiagnostic["reason"] | undefined;
			if (observations.length === 0) reason = "missing-observation";
			else if (observations.length > 1) reason = "duplicate-observation";
			else if (observations[0].outcome === "errored") reason = "harness-error";
			else if (observations[0].outcome === "unscored") {
				reason = "missing-score";
			} else if (observations[0].outcome !== "scored") {
				reason = "unscorable-outcome";
			}
			if (!reason) continue;
			diagnostics.push({
				evalSet: group.evalSet,
				groupKey: group.groupKey,
				testName: group.testName,
				file: group.file,
				repetition: group.repetition,
				seed: group.seed,
				harness,
				reason,
			});
		}
	}
	return diagnostics;
}

function pairObservations(
	groups: readonly ObservationGroup[],
	firstHarness: string,
	secondHarness: string,
): ObservationPair[] {
	const pairs: ObservationPair[] = [];
	for (const group of groups) {
		const first = group.observationsByHarness.get(firstHarness) ?? [];
		const second = group.observationsByHarness.get(secondHarness) ?? [];
		if (first.length === 1 && second.length === 1) pairs.push({ first: first[0], second: second[0] });
	}
	return pairs;
}

function summarizeMetric(
	pairs: readonly ObservationPair[],
	select: (observation: HarnessObservation) => number | undefined,
	totalPairs: number,
): PairedMetricSummary {
	const firstValues: number[] = [];
	const secondValues: number[] = [];
	for (const { first, second } of pairs) {
		if (first.outcome !== "scored" || second.outcome !== "scored") continue;
		const firstValue = select(first);
		const secondValue = select(second);
		if (
			firstValue === undefined ||
			secondValue === undefined ||
			!Number.isFinite(firstValue) ||
			!Number.isFinite(secondValue)
		) {
			continue;
		}
		firstValues.push(firstValue);
		secondValues.push(secondValue);
	}

	const firstMean = mean(firstValues);
	const secondMean = mean(secondValues);
	return {
		totalPairs,
		eligiblePairs: firstValues.length,
		firstMean,
		secondMean,
		meanDelta: firstMean === null || secondMean === null ? null : preciseDifference(secondMean, firstMean),
	};
}

function summarizeCorrectness(pairs: readonly ObservationPair[], totalPairs: number): CorrectnessLiftSummary {
	let eligiblePairs = 0;
	let firstPasses = 0;
	let secondPasses = 0;
	let firstWins = 0;
	let secondWins = 0;
	let ties = 0;

	for (const { first, second } of pairs) {
		if (first.outcome !== "scored" || second.outcome !== "scored") continue;
		eligiblePairs += 1;
		const firstPassed = first.score >= 1;
		const secondPassed = second.score >= 1;
		if (firstPassed) firstPasses += 1;
		if (secondPassed) secondPasses += 1;
		if (firstPassed === secondPassed) ties += 1;
		else if (firstPassed) firstWins += 1;
		else secondWins += 1;
	}

	const firstPassRate = eligiblePairs === 0 ? null : firstPasses / eligiblePairs;
	const secondPassRate = eligiblePairs === 0 ? null : secondPasses / eligiblePairs;
	return {
		totalPairs,
		eligiblePairs,
		firstPassRate,
		secondPassRate,
		lift: firstPassRate === null || secondPassRate === null ? null : preciseDifference(secondPassRate, firstPassRate),
		firstWins,
		secondWins,
		ties,
	};
}

function compareHarnesses(
	firstHarness: HarnessDescriptor,
	secondHarness: HarnessDescriptor,
	groups: readonly ObservationGroup[],
): HarnessPairComparison {
	const pairs = pairObservations(groups, firstHarness.name, secondHarness.name);
	return {
		firstHarness: firstHarness.name,
		secondHarness: secondHarness.name,
		correctness: summarizeCorrectness(pairs, groups.length),
		totalTokens: summarizeMetric(pairs, ({ totalTokens }) => totalTokens, groups.length),
		totalMs: summarizeMetric(pairs, ({ totalMs }) => totalMs, groups.length),
		estimatedCostUsd: summarizeMetric(pairs, ({ estimatedCostUsd }) => estimatedCostUsd, groups.length),
	};
}

export function summarizeHarnessComparisons(observations: readonly HarnessObservation[]): HarnessComparisonReport {
	const evalSets: HarnessEvalSetReport[] = [];
	const diagnostics: HarnessComparisonDiagnostic[] = [];
	for (const [evalSet, data] of [...groupObservations(observations)].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const harnesses = orderedHarnesses(data);
		const groups = orderedGroups(data);
		evalSets.push({
			evalSet,
			comparisons: allPairs(harnesses).map(([first, second]) => compareHarnesses(first, second, groups)),
		});
		diagnostics.push(...collectDiagnostics(harnesses, groups));
	}

	return {
		schemaVersion: 1,
		evalSets,
		diagnostics: diagnostics.sort(
			(left, right) =>
				left.evalSet.localeCompare(right.evalSet) ||
				left.file.localeCompare(right.file) ||
				left.groupKey.localeCompare(right.groupKey) ||
				left.repetition - right.repetition ||
				left.seed - right.seed ||
				left.harness.localeCompare(right.harness),
		),
	};
}

function formatPercentage(value: number | null): string {
	return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatSigned(value: number, fractionDigits: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(fractionDigits)}`;
}

function formatMetric(
	label: string,
	metric: PairedMetricSummary,
	formatValue: (value: number) => string,
	formatDelta: (value: number) => string,
): string {
	if (metric.firstMean === null || metric.secondMean === null || metric.meanDelta === null) {
		return `      ${label.padEnd(13)}unavailable (${metric.eligiblePairs}/${metric.totalPairs} pairs)`;
	}
	return `      ${label.padEnd(13)}${formatValue(metric.secondMean)} vs ${formatValue(metric.firstMean)}, delta ${formatDelta(metric.meanDelta)} (${metric.eligiblePairs}/${metric.totalPairs} pairs)`;
}

export function formatHarnessComparisonReport(report: HarnessComparisonReport): string {
	if (report.evalSets.every(({ comparisons }) => comparisons.length === 0)) return "";
	const lines = ["Harness comparisons"];
	for (const evalSet of report.evalSets) {
		lines.push(`  ${evalSet.evalSet}`);
		for (const comparison of evalSet.comparisons) {
			const { correctness } = comparison;
			const lift = correctness.lift === null ? "unavailable" : `${formatSigned(correctness.lift * 100, 1)} pp`;
			lines.push(`    ${comparison.secondHarness} vs ${comparison.firstHarness}`);
			lines.push(
				`      ${"Pass rate".padEnd(13)}${formatPercentage(correctness.secondPassRate)} vs ${formatPercentage(correctness.firstPassRate)}, lift ${lift} (${correctness.eligiblePairs}/${correctness.totalPairs} pairs)`,
			);
			lines.push(
				formatMetric(
					"Tokens",
					comparison.totalTokens,
					(value) => value.toFixed(1),
					(value) => formatSigned(value, 1),
				),
			);
			lines.push(
				formatMetric(
					"Latency",
					comparison.totalMs,
					(value) => `${value.toFixed(1)}ms`,
					(value) => `${formatSigned(value, 1)}ms`,
				),
			);
			lines.push(
				formatMetric(
					"Est. cost",
					comparison.estimatedCostUsd,
					(value) => `$${value.toFixed(4)}`,
					(value) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`,
				),
			);
		}
	}
	if (report.diagnostics.length > 0) {
		lines.push("  Incomplete observations:");
		for (const diagnostic of report.diagnostics) {
			lines.push(
				`    ${diagnostic.reason}: ${diagnostic.file}/${diagnostic.testName} repetition ${diagnostic.repetition}, harness ${diagnostic.harness}`,
			);
		}
	}
	return lines.join("\n");
}
