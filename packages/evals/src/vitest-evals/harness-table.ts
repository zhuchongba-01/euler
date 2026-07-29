import { createHash, randomBytes } from "node:crypto";
import { attachHarnessRunToError, getHarnessRunFromError, type Harness, type JsonValue } from "vitest-evals/harness";

export const EVAL_HARNESS_ITERATION_ARTIFACT = "vitestEvalsHarnessIteration";

export type EvalHarnessIterationArtifact = {
	schemaVersion: 1;
	evalSet: string;
	groupKey: string;
	harness: string;
	harnesses: string[];
	repetition: number;
	seed: number;
	plannedOrder: number;
};

export type EvalHarnessTableRow<TInput, TOutput extends JsonValue | undefined> = {
	harness: Harness<TInput, TOutput>;
	name: string;
	repetition: number;
	seed: number;
	plannedOrder: number;
};

export type EvalHarnessTableOptions = {
	repetitions?: number;
	seed?: number;
};

type EvalHarnessIterationPlan = Omit<EvalHarnessIterationArtifact, "groupKey">;

export function parseEvalHarnessIterationArtifact(
	value: JsonValue | undefined,
): EvalHarnessIterationArtifact | undefined {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { schemaVersion, evalSet, groupKey, harness, harnesses, repetition, seed, plannedOrder } = value;
	if (
		schemaVersion !== 1 ||
		typeof evalSet !== "string" ||
		typeof groupKey !== "string" ||
		typeof harness !== "string" ||
		!Array.isArray(harnesses) ||
		!harnesses.every((name): name is string => typeof name === "string") ||
		typeof repetition !== "number" ||
		typeof seed !== "number" ||
		typeof plannedOrder !== "number"
	) {
		return undefined;
	}
	return { schemaVersion, evalSet, groupKey, harness, harnesses, repetition, seed, plannedOrder };
}

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function canonicalizeJson(value: unknown, ancestors: WeakSet<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Eval input must contain only finite numbers.");
		return value;
	}
	if (typeof value !== "object") throw new TypeError("Eval input must be JSON-serializable.");
	if (ancestors.has(value)) throw new TypeError("Eval input must not contain circular references.");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const result: JsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new TypeError("Eval input arrays must not be sparse.");
				result.push(canonicalizeJson(value[index], ancestors));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Eval input must contain only plain objects and arrays.");
		}
		const entries: Array<[string, unknown]> = Object.entries(value);
		return Object.fromEntries(
			entries
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]): [string, JsonValue] => [key, canonicalizeJson(item, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}

function deriveInputKey(input: unknown): string {
	if (typeof input === "object" && input !== null && !Array.isArray(input) && "id" in input) {
		const id = input.id;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	const canonicalInput = JSON.stringify(canonicalizeJson(input, new WeakSet()));
	if (canonicalInput === undefined) throw new TypeError("Eval input must be JSON-serializable.");
	return createHash("sha256").update(canonicalInput).digest("hex");
}

export function deriveEvalGroupKey(input: unknown, repetition: number, seed: number): string {
	return JSON.stringify([deriveInputKey(input), repetition, seed]);
}

function validateOptions<TInput, TOutput extends JsonValue | undefined>(
	evalSet: string,
	harnesses: readonly Harness<TInput, TOutput>[],
	repetitions: number,
	seed: number,
): void {
	if (!evalSet.trim()) throw new TypeError("evalSet must not be empty.");
	if (harnesses.length < 2) throw new TypeError("At least two harnesses are required.");
	const names = new Set(harnesses.map((harness) => harness.name));
	if (names.size !== harnesses.length) throw new TypeError("Harness names must be unique within an eval set.");
	if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
		throw new TypeError("repetitions must be a positive integer.");
	}
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
		throw new TypeError("seed must be an unsigned 32-bit integer.");
	}
}

function withIterationArtifact<TInput, TOutput extends JsonValue | undefined>(
	harness: Harness<TInput, TOutput>,
	plan: EvalHarnessIterationPlan,
): Harness<TInput, TOutput> {
	return {
		name: harness.name,
		async run(input, context) {
			const groupKey = deriveEvalGroupKey(input, plan.repetition, plan.seed);
			const artifact: EvalHarnessIterationArtifact = { ...plan, groupKey };
			context.setArtifact(EVAL_HARNESS_ITERATION_ARTIFACT, artifact);
			try {
				const run = await harness.run(input, context);
				run.artifacts = { ...context.artifacts, ...run.artifacts, [EVAL_HARNESS_ITERATION_ARTIFACT]: artifact };
				return run;
			} catch (error) {
				const partialRun = getHarnessRunFromError(error);
				if (partialRun) {
					partialRun.artifacts = {
						...context.artifacts,
						...partialRun.artifacts,
						[EVAL_HARNESS_ITERATION_ARTIFACT]: artifact,
					};
					throw attachHarnessRunToError(error, partialRun);
				}
				throw error;
			}
		},
	};
}

export function evalHarnessTable<TInput, TOutput extends JsonValue | undefined>(
	evalSet: string,
	harnesses: readonly Harness<TInput, TOutput>[],
	options: EvalHarnessTableOptions,
): EvalHarnessTableRow<TInput, TOutput>[] {
	const repetitions = options.repetitions ?? 1;
	const seed = options.seed ?? randomBytes(4).readUInt32LE();
	validateOptions(evalSet, harnesses, repetitions, seed);

	const random = createSeededRandom(seed);
	const rows: EvalHarnessTableRow<TInput, TOutput>[] = [];
	let plannedOrder = 1;
	for (let repetition = 1; repetition <= repetitions; repetition += 1) {
		const randomizedHarnesses = [...harnesses];
		for (let index = randomizedHarnesses.length - 1; index > 0; index -= 1) {
			const target = Math.floor(random() * (index + 1));
			[randomizedHarnesses[index], randomizedHarnesses[target]] = [
				randomizedHarnesses[target],
				randomizedHarnesses[index],
			];
		}
		for (const harness of randomizedHarnesses) {
			const plan: EvalHarnessIterationPlan = {
				schemaVersion: 1,
				evalSet,
				harness: harness.name,
				harnesses: harnesses.map(({ name }) => name),
				repetition,
				seed,
				plannedOrder,
			};
			rows.push({
				harness: withIterationArtifact(harness, plan),
				name: harness.name,
				repetition,
				seed,
				plannedOrder,
			});
			plannedOrder += 1;
		}
	}
	return rows;
}
