import type { Component } from "@zhongchongba/euler-tui";
import { theme } from "../theme/theme.ts";

export interface LineDrawingCharacters {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
}

const UNICODE_LINE_DRAWING: LineDrawingCharacters = {
	horizontal: "─",
	vertical: "│",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
};

const ASCII_LINE_DRAWING: LineDrawingCharacters = {
	horizontal: "-",
	vertical: "|",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
};

export function shouldUseAsciiLineDrawing(env: NodeJS.ProcessEnv = process.env): boolean {
	const term = env.TERM?.toLowerCase();
	return term === "dumb" || term === "unknown" || env.LC_ALL === "C" || env.LANG === "C";
}

export function getLineDrawingCharacters(env: NodeJS.ProcessEnv = process.env): LineDrawingCharacters {
	return shouldUseAsciiLineDrawing(env) ? ASCII_LINE_DRAWING : UNICODE_LINE_DRAWING;
}

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const { horizontal } = getLineDrawingCharacters();
		return [this.color(horizontal.repeat(Math.max(1, width)))];
	}
}
