import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	createSqliteSessionRepo,
	type SqliteSessionMetadata,
	SqliteSessionSearch,
	SqliteSessionStore,
	type SqliteSessionStoreApi,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionRepo, JsonlSessionStore } from "../../src/harness/session/jsonl-repo.ts";
import { SessionRepo } from "../../src/harness/session/repo-utils.ts";
import type {
	JsonlSessionMetadata,
	JsonlSessionStoreApi,
	SessionSearch,
	SessionSearchHit,
	SessionSearchIndex,
	SessionSearchOptions,
	SessionTreeEntry,
} from "../../src/harness/types.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("JsonlSessionStore with scanning search", () => {
	it("searches canonical session entries by scanning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createJsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "AUTH", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
	});
});

describe("SqliteSessionStore with explicit SQLite FTS5 search", () => {
	it("uses SQLite FTS5 when composed with its search backend", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteSessionRepo({ env, sqlite, databasePath });
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

describe("JsonlSessionStore with SQLite search index", () => {
	// This is not the intended production pairing; it exists to demonstrate that
	// Canonical session storage and search are independently swappable/composable.
	it("writes JSONL session entries into the configured SQLite search", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const search = new SqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite,
			databasePath: join(root, "search.sqlite"),
		});
		const canonical = new JsonlSessionStore({ fs: env, sessionsRoot: join(root, "sessions") });
		const store = {
			load: (metadata) => canonical.load(metadata),
			list: (options) => canonical.list(options),
			getEntries: (metadata, options) => canonical.getEntries(metadata, options),
			createEntryId: (metadata) => canonical.createEntryId(metadata),
			async create(options) {
				const metadata = await canonical.create(options);
				await search.replaceSession(metadata, []);
				return metadata;
			},
			async appendEntry(metadata, entry) {
				await canonical.appendEntry(metadata, entry);
				await search.upsertEntry(metadata, entry);
			},
			async setLeafId(metadata, leafId) {
				const entry = await canonical.setLeafId(metadata, leafId);
				await search.upsertEntry(metadata, entry);
				return entry;
			},
			async delete(metadata) {
				await canonical.delete(metadata);
				await search.deleteSession(metadata);
			},
			async fork(source, options) {
				const metadata = await canonical.fork(source, options);
				await search.replaceSession(metadata, (await canonical.load(metadata)).entries);
				return metadata;
			},
		} satisfies JsonlSessionStoreApi;
		const repo = new SessionRepo({ store, search });
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
	});
});

describe("JsonlSessionStore with multiple search indexes", () => {
	it("queries one search implementation and composes index writes explicitly", async () => {
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
		const canonical = new JsonlSessionStore({ fs: env, sessionsRoot: join(root, "sessions") });
		const store = {
			load: (metadata) => canonical.load(metadata),
			list: (options) => canonical.list(options),
			getEntries: (metadata, options) => canonical.getEntries(metadata, options),
			createEntryId: (metadata) => canonical.createEntryId(metadata),
			async create(options) {
				const metadata = await canonical.create(options);
				await primary.replaceSession(metadata, []);
				await secondary.replaceSession(metadata, []);
				return metadata;
			},
			async appendEntry(metadata, entry) {
				await canonical.appendEntry(metadata, entry);
				await primary.upsertEntry(metadata, entry);
				await secondary.upsertEntry(metadata, entry);
			},
			async setLeafId(metadata, leafId) {
				const entry = await canonical.setLeafId(metadata, leafId);
				await primary.upsertEntry(metadata, entry);
				await secondary.upsertEntry(metadata, entry);
				return entry;
			},
			async delete(metadata) {
				await canonical.delete(metadata);
				await primary.deleteSession(metadata);
				await secondary.deleteSession(metadata);
			},
			async fork(source, options) {
				const metadata = await canonical.fork(source, options);
				const entries = (await canonical.load(metadata)).entries;
				await primary.replaceSession(metadata, entries);
				await secondary.replaceSession(metadata, entries);
				return metadata;
			},
		} satisfies JsonlSessionStoreApi;
		const repo = new SessionRepo({ store, search: primary });
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

describe("SqliteSessionStore with custom search", () => {
	it("can swap out the default search implementation", async () => {
		const root = createTempDir();
		const upserts: Array<{ metadata: SqliteSessionMetadata; entry: SessionTreeEntry }> = [];
		const removals: SqliteSessionMetadata[] = [];
		const searches: SessionSearchOptions[] = [];
		const index: SessionSearchIndex<SqliteSessionMetadata> = {
			async upsertEntry(metadata, entry) {
				upserts.push({ metadata, entry });
			},
			async replaceSession(metadata, entries: readonly SessionTreeEntry[]) {
				for (const entry of entries) upserts.push({ metadata, entry });
			},
			async deleteSession(metadata) {
				removals.push(metadata);
			},
		};
		const search: SessionSearch<SqliteSessionMetadata> = {
			async search(options): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
				searches.push(options);
				return [];
			},
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const canonical = new SqliteSessionStore({ env, sqlite, databasePath });
		const store = {
			load: (metadata) => canonical.load(metadata),
			list: (options) => canonical.list(options),
			getEntries: (metadata, options) => canonical.getEntries(metadata, options),
			createEntryId: (metadata) => canonical.createEntryId(metadata),
			async create(options) {
				const metadata = await canonical.create(options);
				await index.replaceSession(metadata, []);
				return metadata;
			},
			async appendEntry(metadata, entry) {
				await canonical.appendEntry(metadata, entry);
				await index.upsertEntry(metadata, entry);
			},
			async setLeafId(metadata, leafId) {
				const entry = await canonical.setLeafId(metadata, leafId);
				await index.upsertEntry(metadata, entry);
				return entry;
			},
			async delete(metadata) {
				await canonical.delete(metadata);
				await index.deleteSession(metadata);
			},
			async fork(source, options) {
				const metadata = await canonical.fork(source, options);
				await index.replaceSession(metadata, (await canonical.load(metadata)).entries);
				return metadata;
			},
		} satisfies SqliteSessionStoreApi;
		const repo = new SessionRepo({ store, search });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed remotely"));
		await session.moveTo(null);

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
