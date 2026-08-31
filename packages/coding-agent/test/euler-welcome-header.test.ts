import { stripTerminalSequences, visibleWidth } from "@zhongchongba/euler-tui";
import { describe, expect, test } from "vitest";
import {
	EulerWelcomePanel,
	formatRelativeTime,
	getEulerSessionLabel,
	shouldShowEulerWelcome,
	shouldShowStartupResources,
} from "../src/modes/interactive/components/euler-welcome-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("EulerWelcomePanel", () => {
	test("renders a two-column welcome panel with recent sessions", () => {
		initTheme("dark");
		const panel = new EulerWelcomePanel({ cwd: "C:/work/euler", modelLabel: "OpenAI / GPT-5", version: "0.1.2" });
		panel.setRecentSessions([
			{ cwd: "C:/work/euler", label: "Fix startup", modified: new Date(Date.now() - 60_000) },
		]);

		const lines = panel.render(100).map((line) => stripTerminalSequences(line));

		expect(lines.some((line) => line.includes("Euler v0.1.2"))).toBe(true);
		expect(lines.some((line) => line.includes("Recent activity"))).toBe(true);
		expect(lines.some((line) => line.includes("Fix startup"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 100)).toBe(true);
	});

	test("stacks content in narrow terminals", () => {
		initTheme("dark");
		const panel = new EulerWelcomePanel({ cwd: "C:/work/euler", modelLabel: "No model selected", version: "0.1.2" });
		panel.setRecentSessions([]);

		const lines = panel.render(60).map((line) => stripTerminalSequences(line));

		expect(lines.findIndex((line) => line.includes("Welcome back!"))).toBeLessThan(
			lines.findIndex((line) => line.includes("Recent activity")),
		);
		expect(lines.every((line) => visibleWidth(line) === 60)).toBe(true);
	});
});

describe("welcome panel helpers", () => {
	test("formats session labels and relative times", () => {
		expect(getEulerSessionLabel({ name: "  Release work  ", firstMessage: "ignored" })).toBe("Release work");
		expect(getEulerSessionLabel({ firstMessage: "  Review\nthis change  " })).toBe("Review this change");
		expect(formatRelativeTime(new Date(0), new Date(3_600_000))).toBe("1h ago");
	});

	test("shows welcome and resources only in their intended states", () => {
		expect(shouldShowEulerWelcome(true, false)).toBe(true);
		expect(shouldShowEulerWelcome(false, false)).toBe(false);
		expect(shouldShowStartupResources(false, false)).toBe(false);
		expect(shouldShowStartupResources(false, true)).toBe(true);
	});
});
