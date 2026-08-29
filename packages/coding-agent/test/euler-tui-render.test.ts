import { setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { DynamicBorder, getLineDrawingCharacters } from "../src/modes/interactive/components/dynamic-border.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createEulerWelcomeHeaderText } from "../src/modes/interactive/interactive-mode.ts";
import { getThemeByName, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createEditor(width = 80): CustomEditor {
	const keybindings = KeybindingsManager.create();
	setKeybindings(keybindings);
	const terminal = new VirtualTerminal(width, 24);
	const tui = new TuiMainScreen(terminal);
	return new CustomEditor(tui, defaultEditorTheme, keybindings);
}

function createFooterSession(): AgentSession {
	return {
		state: {
			model: {
				id: "euler-model",
				provider: "test-provider",
				contextWindow: 120_000,
				reasoning: true,
			},
			thinkingLevel: "medium",
		},
		sessionManager: {
			getEntries: () => [],
			getSessionName: () => "task-eight",
			getCwd: () => "C:\\work\\euler",
		},
		getContextUsage: () => ({ contextWindow: 120_000, percent: 42.5 }),
		modelRuntime: {
			isUsingSubscription: () => false,
		},
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "codex/task8",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 2,
		onBranchChange: () => () => {},
	};
}

function createFakeTui() {
	return {
		requestRender: () => {},
	} as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5];
}

beforeEach(() => {
	vi.stubEnv("TERM", "xterm-256color");
	vi.stubEnv("LANG", "en_US.UTF-8");
	vi.stubEnv("LC_ALL", "");
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(new KeybindingsManager());
	vi.unstubAllEnvs();
});

describe("Euler TUI rendering", () => {
	it("renders a compact Euler welcome header without PI product branding", () => {
		const header = createEulerWelcomeHeaderText("1.2.3");
		const compact = stripAnsi(header.compact);
		const expanded = stripAnsi(header.expanded);

		expect(compact).toContain("Euler v1.2.3");
		expect(compact).toContain("commands");
		expect(compact).toContain("search");
		expect(expanded).toContain("to select model");
		expect(`${compact}\n${expanded}`).not.toMatch(/\bPI\b|\bPi\b|π/);
	});

	it("wraps the existing editor in one rounded box", () => {
		const editor = createEditor();
		editor.setText("hello");

		const lines = editor.render(24).map(stripAnsi);

		expect(lines[0]).toBe(`╭${"─".repeat(22)}╮`);
		expect(lines.at(-1)).toBe(`╰${"─".repeat(22)}╯`);
		expect(lines.some((line) => line.startsWith("│") && line.endsWith("│") && line.includes("hello"))).toBe(true);
		expect(lines.filter((line) => /^─+$/.test(line))).toHaveLength(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});

	it("keeps narrow editor output within the viewport", () => {
		const editor = createEditor(4);
		editor.setText("abcdef");

		for (const line of editor.render(4)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(4);
		}
	});

	it("falls back to ASCII line drawing for non-Unicode terminals", () => {
		vi.stubEnv("TERM", "dumb");
		const chars = getLineDrawingCharacters();
		const border = stripAnsi(new DynamicBorder((text) => text).render(6)[0]);
		const editor = createEditor();
		const lines = editor.render(12).map(stripAnsi);

		expect(chars.topLeft).toBe("+");
		expect(border).toBe("------");
		expect(lines[0]).toBe(`+${"-".repeat(10)}+`);
		expect(lines.at(-1)).toBe(`+${"-".repeat(10)}+`);
		expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│─]/);
	});

	it("uses valid light and dark themes for Euler chrome", () => {
		for (const name of ["dark", "light"]) {
			initTheme(name);
			const loadedTheme = getThemeByName(name);
			expect(loadedTheme?.name).toBe(name);
			expect(theme.getFgAnsi("borderMuted")).toMatch(/^\x1b\[/);
			expect(theme.getBgAnsi("toolPendingBg")).toMatch(/^\x1b\[/);
		}
	});

	it("keeps mode, model, git branch, and context in the footer", () => {
		const footer = new FooterComponent(createFooterSession(), createFooterData(), "fullscreen");
		const lines = footer.render(100).map(stripAnsi);

		expect(lines[0]).toContain("(codex/task8)");
		expect(lines[1]).toContain("mode:fullscreen");
		expect(lines[1]).toContain("42.5%/120k");
		expect(lines[1]).toContain("(test-provider) euler-model");
	});

	it("renders tool cards with distinct theme tokens for running, success, and failure", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-euler-status",
			{ query: "Euler" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		expect(component.render(80).join("\n")).toContain(theme.getBgAnsi("toolPendingBg"));

		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(component.render(80).join("\n")).toContain(theme.getBgAnsi("toolSuccessBg"));

		component.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
		expect(component.render(80).join("\n")).toContain(theme.getBgAnsi("toolErrorBg"));
	});

	it("preserves app keybinding dispatch through the custom editor", () => {
		const editor = createEditor();
		const selectModel = vi.fn();
		editor.onAction("app.model.select", selectModel);

		editor.handleInput("\x0c");

		expect(selectModel).toHaveBeenCalledOnce();
	});
});
