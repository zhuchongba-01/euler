import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getLineDrawingCharacters } from "./dynamic-border.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	override render(width: number): string[] {
		if (width < 3) {
			return super.render(width);
		}

		const innerWidth = Math.max(1, width - 2);
		const innerLines = super.render(innerWidth);
		if (innerLines.length === 0) {
			return [];
		}

		const chars = getLineDrawingCharacters();
		const bottomBorderIndex = innerLines.findIndex(
			(line, index) => index > 0 && isEditorBorderLine(line, innerWidth),
		);

		return innerLines.map((line, index) => {
			if (index === 0) {
				return this.borderColor(chars.topLeft + chars.horizontal.repeat(innerWidth) + chars.topRight);
			}
			if (index === bottomBorderIndex) {
				return this.borderColor(chars.bottomLeft + chars.horizontal.repeat(innerWidth) + chars.bottomRight);
			}

			const content = fitLineToWidth(line, innerWidth);
			if (bottomBorderIndex !== -1 && index > bottomBorderIndex) {
				return ` ${content}`;
			}
			return this.borderColor(chars.vertical) + content + this.borderColor(chars.vertical);
		});
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}

function isEditorBorderLine(line: string, width: number): boolean {
	if (visibleWidth(line) !== width) {
		return false;
	}
	const stripped = stripAnsi(line);
	return /^─+$/.test(stripped) || /^─── [↑↓] /.test(stripped);
}

function fitLineToWidth(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth === width) {
		return line;
	}
	if (lineWidth > width) {
		return truncateToWidth(line, width, "");
	}
	return line + " ".repeat(width - lineWidth);
}
