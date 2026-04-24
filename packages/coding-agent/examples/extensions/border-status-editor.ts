import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

function fitBorder(left: string, right: string, width: number, fill: (text: string) => string): string {
	if (width <= 0) return "";
	if (width === 1) return fill("─");

	let leftText = left;
	let rightText = right;
	const edgeWidth = 1;
	const minimumGap = 1;

	while (
		edgeWidth * 2 + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		edgeWidth * 2 + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - edgeWidth * 2 - visibleWidth(leftText) - visibleWidth(rightText));
	return `${fill("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${fill("─")}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.percent === null) {
		return "context unknown";
	}
	return `${Math.round(usage.percent)}% of ${(usage.contextWindow / 1000).toFixed(1)}k`;
}

function formatSessionCost(ctx: ExtensionContext): string {
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalCost += entry.message.usage.cost.total;
		}
	}
	return `$${totalCost.toFixed(3)}`;
}

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	pi.on("agent_start", () => {
		isWorking = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());

		let branch: string | undefined;

		const refreshBranch = async () => {
			const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
			const stdout = result?.stdout.trim();
			branch = stdout && stdout.length > 0 ? stdout : undefined;
			activeTui?.requestRender();
		};
		void refreshBranch();

		class BorderStatusEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const model = ctx.model ? `(${ctx.model.provider}) ${ctx.model.id}` : "no model";
				const thinking = pi.getThinkingLevel();
				const workingText = isWorking ? `${spinnerFrames[spinnerIndex]} working` : "idle";
				const topLeft = thm.fg("muted", ` ${formatContext(ctx)} · ${formatSessionCost(ctx)} `);
				const topRight = thm.fg("muted", ` ${model} · ${thinking} `);
				const bottomLeft = isWorking ? thm.fg("accent", ` ${workingText} `) : thm.fg("muted", ` ${workingText} `);
				const bottomRight = thm.fg("muted", ` ${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""} `);

				lines[0] = fitBorder(topLeft, topRight, width, (text) => this.borderColor(text.replace(/ /g, "─")));
				lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, (text) =>
					this.borderColor(text.replace(/ /g, "─")),
				);
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BorderStatusEditor(tui, theme, keybindings));
	});
}
