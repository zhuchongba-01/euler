import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteSessionMetadata,
	SqliteSessionRepo,
	SqliteSessionSearchBackend,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import type {
	SessionSearchBackend,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
} from "../../src/harness/types.ts";
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

describe("SqliteSessionRepo with default SQLite FTS5 search", () => {
	it("uses SQLite FTS5 by default", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath });
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

		const db = await sqlite.open(databasePath);
		try {
			const tables = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>();
			expect(tables.map((row) => row.name)).toContain("session_search_fts");
			expect(tables.map((row) => row.name)).not.toContain("session_search_records");
		} finally {
			await db.close();
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

describe("SqliteSessionRepo with custom search backend", () => {
	it("can swap out the default search backend", async () => {
		const root = createTempDir();
		const upserts: SessionSearchRecord<SqliteSessionMetadata>[] = [];
		const removals: SqliteSessionMetadata[] = [];
		const searches: SessionSearchOptions[] = [];
		const backend: SessionSearchBackend<SqliteSessionMetadata> = {
			async upsert(record) {
				upserts.push(record);
			},
			async removeSession(metadata) {
				removals.push(metadata);
			},
			async search(options): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
				searches.push(options);
				return [];
			},
		};
		const repo = new SqliteSessionRepo({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
			searchBackendFactory: { create: () => backend },
		});
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed remotely"));

		expect(upserts).toContainEqual(
			expect.objectContaining({ metadata, entry: expect.objectContaining({ id: entryId }) }),
		);
		await expect(repo.search({ text: "indexed remotely" })).resolves.toEqual([]);
		expect(searches).toEqual([{ text: "indexed remotely" }]);
		await repo.delete(metadata);
		expect(removals).toEqual([metadata]);
	});
});
