import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

function parsePosixEditorCommand(command: string): string[] | undefined {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let hasToken = false;

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			hasToken = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			hasToken = true;
			continue;
		}
		if (char === "'" || char === '"') {
			if (quote === undefined) {
				quote = char;
				hasToken = true;
				continue;
			}
			if (quote === char) {
				quote = undefined;
				continue;
			}
		}
		if (/\s/.test(char) && quote === undefined) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}
		current += char;
		hasToken = true;
	}

	if (escaped || quote !== undefined || !hasToken) return undefined;
	args.push(current);
	return args;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), `${APP_NAME}-editor-`));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		// On Windows the command runs through cmd.exe, which resolves quoted
		// paths itself; keep the raw command string intact so editors installed
		// under "Program Files" work. POSIX needs shell-like tokenization so a
		// quoted executable path does not retain its quote characters.
		const command = process.platform === "win32" ? [options.command] : parsePosixEditorCommand(options.command);
		if (!command) return { status: "failed" };
		const [editor, ...editorArgs] = command;
		process.stdout.write(
			`Launching external editor: ${options.command}\n${APP_NAME} will resume when the editor exits.\n`,
		);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
