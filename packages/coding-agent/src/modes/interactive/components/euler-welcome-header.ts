import { APP_TITLE } from "../../../config.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

export function createEulerWelcomeHeaderText(version: string): { compact: string; expanded: string } {
	const logo = theme.bold(theme.fg("accent", APP_TITLE)) + theme.fg("dim", ` v${version}`);
	const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
	const expandedInstructions = [
		hint("app.interrupt", "to interrupt"),
		hint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		hint("app.exit", "to exit (empty)"),
		hint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		hint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
		hint("app.model.select", "to select model"),
		hint("app.tools.expand", "to expand tools"),
		hint("app.thinking.toggle", "to expand thinking"),
		hint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		hint("app.message.followUp", "to queue follow-up"),
		hint("app.message.dequeue", "to edit all queued messages"),
		hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
		rawKeyHint("drop files", "to attach"),
	].join("\n");
	const compactInstructions = [
		hint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));
	const compactOnboarding = theme.fg(
		"dim",
		`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
	);
	const onboarding = theme.fg("dim", "Ask Euler about commands, tools, search, or the current project context.");
	return {
		compact: `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
		expanded: `${logo}\n${expandedInstructions}\n\n${onboarding}`,
	};
}
