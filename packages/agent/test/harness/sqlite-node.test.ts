import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteSessionMetadata,
	SqliteSessionRepo,
	SqliteSessionSearch,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { FanoutSessionSearch } from "../../src/harness/session/search-backend.ts";
import type {
	JsonlSessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchIndex,
	SessionSearchOptions,
	SessionSearchRecord,
	SessionTreeEntry,
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
	// Canonical session storage and search are independently swappable/composable.
	it("writes JSONL session entries into the configured SQLite search", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new JsonlSessionRepo({
			fs: env,
			sessionsRoot: join(root, "sessions"),
			search: new SqliteSessionSearch({ env, sqlite, databasePath: join(root, "search.sqlite") }),
		});
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
	});
});

describe("JsonlSessionRepo with multiple search indexes", () => {
	it("queries one search implementation and fans index writes out to both", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const primary = new SqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite,
			databasePath: join(root, "primary-search.sqlite"),
		});
		const secondary = new SqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite,
			databasePath: join(root, "secondary-search.sqlite"),
		});
		const repo = new JsonlSessionRepo({
			fs: env,
			sessionsRoot: join(root, "sessions"),
			search: new FanoutSessionSearch({ reader: primary, writers: [primary, secondary] }),
		});
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const entryId = await session.appendMessage(createUserMessage("indexed in both places"));

		await expect(repo.search({ text: "both" })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
		await expect(secondary.search({ text: "both" })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
	});
});

describe("SqliteSessionRepo with custom search", () => {
	it("can swap out the default search implementation", async () => {
		const root = createTempDir();
		const upserts: SessionSearchRecord<SqliteSessionMetadata>[] = [];
		const removals: SqliteSessionMetadata[] = [];
		const searches: SessionSearchOptions[] = [];
		const index: SessionSearchIndex<SqliteSessionMetadata> = {
			async upsert(record) {
				upserts.push(record);
			},
			async replaceSession(metadata, entries: readonly SessionTreeEntry[]) {
				for (const entry of entries) upserts.push({ metadata, entry });
			},
			async removeSession(metadata) {
				removals.push(metadata);
			},
		};
		const search: SessionSearch<SqliteSessionMetadata> = {
			index,
			async search(options): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
				searches.push(options);
				return [];
			},
		};
		const repo = new SqliteSessionRepo({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
			search,
		});
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed remotely"));
		await session.getStorage().setLeafId(null);

		expect(upserts).toContainEqual(
			expect.objectContaining({ metadata, entry: expect.objectContaining({ id: entryId }) }),
		);
		expect(upserts).toContainEqual(
			expect.objectContaining({ metadata, entry: expect.objectContaining({ type: "leaf", targetId: null }) }),
		);
		await expect(repo.search({ text: "indexed remotely" })).resolves.toEqual([]);
		expect(searches).toEqual([{ text: "indexed remotely" }]);
		await repo.delete(metadata);
		expect(removals).toEqual([metadata]);
	});
});
