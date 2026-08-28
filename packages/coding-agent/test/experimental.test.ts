import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.EULER_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.EULER_EXPERIMENTAL;
		} else {
			process.env.EULER_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when EULER_EXPERIMENTAL is unset", () => {
		delete process.env.EULER_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when EULER_EXPERIMENTAL is empty", () => {
		process.env.EULER_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when EULER_EXPERIMENTAL is set to 1", () => {
		process.env.EULER_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when EULER_EXPERIMENTAL is set to 0", () => {
		process.env.EULER_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when EULER_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.EULER_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
