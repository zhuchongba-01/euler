import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	createSqliteSessionSearch,
	createSqliteSessionStore,
	type SqliteSessionMetadata,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionStore } from "../../src/harness/session/jsonl-store.ts";
import { createSessionRepository } from "../../src/harness/session/repository.ts";
import { createScanningSessionSearch } from "../../src/harness/session/search-backend.ts";
import { rebuildSessionSearchIndex } from "../../src/harness/session/search-index.ts";
import type {
	JsonlSessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchIndex,
	SessionSearchOptions,
	SessionTreeEntry,
} from "../../src/harness/types.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

const ownedStores: AsyncDisposable[] = [];

afterEach(async () => {
	for (const store of ownedStores.splice(0)) await store[Symbol.asyncDispose]();
});

function createSqliteRepository(options: Parameters<typeof createSqliteSessionStore>[0]) {
	const store = createSqliteSessionStore(options);
	ownedStores.push(store);
	return createSessionRepository({
		store,
		search: createSqliteSessionSearch<SqliteSessionMetadata>({ ...options, mode: "canonical" }),
	});
}

function createJsonlRepository(options: Parameters<typeof createJsonlSessionStore>[0]) {
	const store = createJsonlSessionStore(options);
	ownedStores.push(store);
	return createSessionRepository({ store, search: createScanningSessionSearch(store) });
}

describe("JsonlSessionStore with scanning search", () => {
	it("searches canonical session entries by scanning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createJsonlRepository({ fs: env, sessionsRoot: join(root, "sessions") });
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
	it("uses SQLite FTS5 when composed with its search store", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
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

	it("creates an empty canonical session without initializing FTS", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			const fts = await db
				.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'session_search_fts'")
				.get<{ found: number }>();
			expect(fts).toBeUndefined();
		} finally {
			await db.close();
		}
		await expect(session.appendMessage(createUserMessage("still writable"))).resolves.toBeTypeOf("string");
	});

	it("rolls back canonical appends when co-located FTS trigger writes fail", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		await repo.search({ text: "initialize" });
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(session.appendMessage(createUserMessage("must roll back"))).rejects.toThrow();
		await expect(session.getEntries()).resolves.toEqual([]);
	});

	it("rolls back canonical deletion when co-located FTS cleanup fails", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		await repo.search({ text: "initialize" });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("must remain"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(repo.delete(metadata)).rejects.toThrow();
		const reopened = await repo.open(metadata);
		await expect(reopened.getEntries()).resolves.toHaveLength(1);
	});

	it("initializes canonical storage when searched before the first session is created", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSqliteRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});

		await expect(repo.search({ text: "auth" })).resolves.toEqual([]);
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth" })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "session-1" }) }),
		]);
		await expect(session.appendMessage(createUserMessage("Still writable"))).resolves.toBeTypeOf("string");
	});
});

describe("Session search index rebuild", () => {
	it("removes sessions that no longer exist in canonical storage", async () => {
		const root = createTempDir();
		const search = createSqliteSessionSearch<JsonlSessionMetadata>({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "search.sqlite"),
		});
		const metadata: JsonlSessionMetadata = {
			id: "deleted",
			createdAt: "2026-01-01T00:00:00.000Z",
			cwd: root,
			path: join(root, "deleted.jsonl"),
		};
		await search.upsertEntry(metadata, {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: metadata.createdAt,
			message: createUserMessage("stale entry"),
		});
		await rebuildSessionSearchIndex(
			{
				async list() {
					return [];
				},
				async load() {
					throw new Error("load should not be called");
				},
			},
			search,
		);
		await expect(search.search({ text: "stale" })).resolves.toEqual([]);
	});
});

describe("JsonlSessionStore with SQLite search index", () => {
	it("allows explicit projection into an independently configured SQLite index", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const search = createSqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "search.sqlite"),
		});
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: join(root, "sessions") });
		const repo = createSessionRepository({ store, search });
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));
		const entry = await session.getEntry(entryId);
		expect(entry).toBeDefined();
		await search.upsertEntry(metadata, entry!);

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "jsonl-session" }) }),
		]);
	});
});

describe("JsonlSessionStore with multiple search indexes", () => {
	it("queries one search implementation and projects writes explicitly", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const primary = createSqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite,
			databasePath: join(root, "primary-search.sqlite"),
		});
		const secondary = createSqliteSessionSearch<JsonlSessionMetadata>({
			env,
			sqlite,
			databasePath: join(root, "secondary-search.sqlite"),
		});
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: join(root, "sessions") });
		const repo = createSessionRepository({ store, search: primary });
		const session = await repo.create({ cwd: root, id: "jsonl-session" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed in both places"));
		const entry = await session.getEntry(entryId);
		expect(entry).toBeDefined();
		await primary.upsertEntry(metadata, entry!);
		await secondary.upsertEntry(metadata, entry!);

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
			async reset() {
				upserts.length = 0;
				removals.length = 0;
			},
			async upsertEntry(metadata, entry) {
				upserts.push({ metadata, entry });
			},
			async replaceSession(metadata, entries) {
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
		const store = createSqliteSessionStore({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const repo = createSessionRepository({ store, search });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed remotely"));
		const entry = await session.getEntry(entryId);
		expect(entry).toBeDefined();
		await index.upsertEntry(metadata, entry!);
		await session.moveTo(null);
		const leafEntry = (await session.getEntries()).at(-1);
		expect(leafEntry?.type).toBe("leaf");
		await index.upsertEntry(metadata, leafEntry!);

		expect(upserts).toContainEqual(
			expect.objectContaining({ metadata, entry: expect.objectContaining({ id: entryId }) }),
		);
		expect(upserts).toContainEqual(
			expect.objectContaining({ metadata, entry: expect.objectContaining({ type: "leaf", targetId: null }) }),
		);
		await expect(repo.search({ text: "indexed remotely" })).resolves.toEqual([]);
		expect(searches).toEqual([{ text: "indexed remotely" }]);
		await index.deleteSession(metadata);
		await repo.delete(metadata);
		expect(removals).toEqual([metadata]);
	});
});
