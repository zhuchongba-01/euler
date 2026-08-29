/**
 * E2E: offline session smoke.
 *
 * Exercises the offline-available parts of the session lifecycle against an
 * isolated agent dir: new session, append, tree/branch, restore, export
 * round-trip, and compaction entry handling. No LLM and no network involved.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSessionContext,
	findMostRecentSession,
	parseSessionEntries,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("euler session smoke e2e", () => {
	it("creates, restores, branches, and exports sessions offline", () => {
		const sessionDir = join(mkdtempSync(join(tmpdir(), "euler-sess-")), "sessions");
		tempDirs.push(sessionDir);

		// New session with persisted file.
		const first = SessionManager.create(join(sessionDir, "cwd"), sessionDir);
		first.appendSessionInfo("smoke-session");
		const rootUser = first.appendMessage(userMsg("root question"));
		first.appendMessage(userMsg("follow-up"));
		// Session files materialize on the first assistant entry (newSession contract).
		first.appendMessage(assistantMsg("assistant answer"));
		const sessionFile = first.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		// Branch from the root entry: the leaf moves back, append continues the tree.
		first.branch(rootUser);
		first.appendMessage(userMsg("branch answer"));
		const tree = first.getTree();
		expect(tree.length).toBeGreaterThan(0);

		// Restore: the most recent session file loads with the same tree.
		const recent = findMostRecentSession(sessionDir);
		expect(recent).not.toBeNull();
		const restored = SessionManager.create(join(sessionDir, "cwd"), sessionDir);
		restored.setSessionFile(recent!);
		const entries = restored.getEntries();
		expect(entries.some((entry) => entry.type === "message")).toBe(true);

		// Context building walks the active branch only.
		const context = buildSessionContext(restored.getEntries());
		expect(context.messages.length).toBeGreaterThan(0);

		// Export/import round-trip: entries survive a JSONL copy.
		const exported = parseSessionEntries(readFileSync(sessionFile!, "utf-8"));
		const copyPath = join(sessionDir, "copy.jsonl");
		writeFileSync(copyPath, exported.map((entry) => JSON.stringify(entry)).join("\n"));
		const imported = SessionManager.create(join(sessionDir, "cwd"), sessionDir);
		imported.setSessionFile(copyPath);
		expect(imported.getEntries().length).toBe(first.getEntries().length);
	});

	it("keeps compaction entries parseable and restorable offline", () => {
		const manager = SessionManager.inMemory();
		const beforeId = manager.appendMessage(userMsg("before compaction"));
		manager.appendCompaction("compacted summary", beforeId, 1234, { details: [] });
		const entries = manager.getEntries();
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);

		// The entries round-trip through the on-disk format without a model call.
		const parsed = parseSessionEntries(entries.map((entry) => JSON.stringify(entry)).join("\n"));
		expect(parsed.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
