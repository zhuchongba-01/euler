import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	SqliteSessionRepo,
	SqliteSessionSearchBackend,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("JsonlSessionRepo with scanning search", () => {
	it("searches canonical session entries by scanning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "AUTH", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
	});
});

describe("SqliteSessionRepo with SQLite FTS5 search", () => {
	it("uses the configured SQLite search backend", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepo({
			env,
			sqlite,
			databasePath: join(root, "sessions.sqlite"),
			searchBackendFactory: {
				create: () => new SqliteSessionSearchBackend({ env, sqlite, databasePath: join(root, "search.sqlite") }),
			},
		});
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const metadata = await included.getMetadata();
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
		await expect(repo.search({ text: "uth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);

		const searchDb = await sqlite.open(join(root, "search.sqlite"));
		try {
			const searchTables = await searchDb
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>();
			expect(searchTables.map((row) => row.name)).not.toContain("session_search_records");
		} finally {
			await searchDb.close();
		}

		await repo.delete(metadata);
		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([]);
	});
});

describe("JsonlSessionRepo with SQLite search index", () => {
	// This is not the intended production pairing; it exists to demonstrate that
	// canonical session storage and search backends are swappable/composable.
	it("writes JSONL session entries into the configured SQLite search backend", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new JsonlSessionRepo({
			fs: env,
			sessionsRoot: join(root, "sessions"),
			searchBackendFactory: {
				create: () => new SqliteSessionSearchBackend({ env, sqlite, databasePath: join(root, "search.sqlite") }),
			},
		});
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
	});
});
