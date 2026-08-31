import { type Component, truncateToWidth, visibleWidth } from "@zhongchongba/euler-tui";
import { theme } from "../theme/theme.ts";
import { getLineDrawingCharacters } from "./dynamic-border.ts";

export interface EulerWelcomeSession {
	cwd: string;
	label: string;
	modified: Date;
}

export interface EulerWelcomePanelOptions {
	cwd: string;
	modelLabel: string;
	version: string;
}

export function formatRelativeTime(modified: Date, now = new Date()): string {
	const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - modified.getTime()) / 1000));
	if (elapsedSeconds < 60) return "just now";
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours}h ago`;
	return `${Math.floor(elapsedHours / 24)}d ago`;
}

export function getEulerSessionLabel(session: { firstMessage: string; name?: string }): string {
	const preferred = session.name?.trim() || session.firstMessage.replace(/\s+/g, " ").trim();
	return preferred || "Untitled session";
}

export function shouldShowEulerWelcome(isEmptySession: boolean, quietStartup: boolean): boolean {
	return isEmptySession && !quietStartup;
}

export function shouldShowStartupResources(verbose: boolean, expanded: boolean): boolean {
	return verbose || expanded;
}

export class EulerWelcomePanel implements Component {
	private readonly options: EulerWelcomePanelOptions;
	private recentSessions: EulerWelcomeSession[] | undefined;

	constructor(options: EulerWelcomePanelOptions) {
		this.options = options;
	}

	setRecentSessions(recentSessions: EulerWelcomeSession[]): void {
		this.recentSessions = recentSessions.slice(0, 3);
	}

	invalidate(): void {
		// The panel derives its output from immutable options and recent-session state.
	}

	render(width: number): string[] {
		const panelWidth = Math.max(20, width);
		const { bottomLeft, bottomRight, horizontal, topLeft, topRight, vertical } = getLineDrawingCharacters();
		const contentWidth = panelWidth - 2;
		const top = theme.fg("border", `${topLeft}${horizontal.repeat(contentWidth)}${topRight}`);
		const bottom = theme.fg("border", `${bottomLeft}${horizontal.repeat(contentWidth)}${bottomRight}`);
		const frameLine = (content: string): string =>
			theme.fg("border", vertical) + padToWidth(content, contentWidth) + theme.fg("border", vertical);

		if (panelWidth < 78) {
			return [
				top,
				...this.getLeftColumnLines().map(frameLine),
				frameLine(theme.fg("border", horizontal.repeat(contentWidth))),
				...this.getRightColumnLines().map(frameLine),
				bottom,
			];
		}

		const leftWidth = Math.floor((contentWidth - 5) / 2);
		const rightWidth = contentWidth - 5 - leftWidth;
		const leftLines = this.getLeftColumnLines();
		const rightLines = this.getRightColumnLines();
		const rowCount = Math.max(leftLines.length, rightLines.length);
		const rows = Array.from({ length: rowCount }, (_, index) => {
			const left = padToWidth(leftLines[index] ?? "", leftWidth);
			const right = padToWidth(rightLines[index] ?? "", rightWidth);
			return `${theme.fg("border", vertical)} ${left} ${theme.fg("border", vertical)} ${right} ${theme.fg("border", vertical)}`;
		});

		return [top, ...rows, bottom];
	}

	private getLeftColumnLines(): string[] {
		return [
			theme.bold(theme.fg("accent", `Euler v${this.options.version}`)),
			"",
			theme.bold("Welcome back!"),
			"",
			`${theme.fg("muted", "Model: ")}${this.options.modelLabel}`,
			`${theme.fg("muted", "Directory: ")}${this.options.cwd}`,
			"",
			theme.fg("dim", "Ctrl+O resources · / commands · ! bash"),
		];
	}

	private getRightColumnLines(): string[] {
		const lines = [theme.bold(theme.fg("accent", "Recent activity")), ""];
		if (!this.recentSessions) {
			return [...lines, theme.fg("dim", "Loading recent Euler sessions...")];
		}
		if (this.recentSessions.length === 0) {
			return [...lines, theme.fg("dim", "No recent Euler activity")];
		}
		for (const session of this.recentSessions) {
			lines.push(`${session.label} ${theme.fg("dim", `· ${formatRelativeTime(session.modified)}`)}`);
			lines.push(theme.fg("dim", session.cwd));
		}
		return lines;
	}
}

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "…");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
