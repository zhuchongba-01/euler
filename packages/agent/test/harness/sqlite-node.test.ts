import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteSessionMetadata,
	SqliteSessionRepo,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import type {
	SessionSearchBackend,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
} from "../../src/harness/types.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("sqlite-node adapter", () => {
	it("supports node:sqlite-style named parameters", async () => {
		const root = createTempDir();
		const databasePath = join(root, "adapter.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
			await db.prepare("INSERT INTO items (id, text) VALUES ($id, $text)").run({ $id: 1, $text: "hello" });
			const row = await db.prepare("SELECT text FROM items WHERE id = $id").get<{ text: string }>({ $id: 1 });
			expect(row).toEqual({ text: "hello" });
		} finally {
			await db.close();
		}
	});

	it("delegates lifecycle events and queries to an injected search backend", async () => {
		const root = createTempDir();
		const upserts: SessionSearchRecord<SqliteSessionMetadata>[] = [];
		const removals: SessionSearchRecord<SqliteSessionMetadata>[] = [];
		const searches: SessionSearchOptions[] = [];
		const index: SessionSearchBackend<SqliteSessionMetadata> = {
			async upsert(record) {
				upserts.push(record);
			},
			async remove(record) {
				removals.push(record);
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
			searchBackendFactory: () => index,
		});
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("indexed remotely"));

		expect(upserts).toEqual([expect.objectContaining({ metadata, entry: expect.objectContaining({ id: entryId }) })]);
		await expect(repo.search({ text: "indexed remotely" })).resolves.toEqual([]);
		expect(searches).toEqual([{ text: "indexed remotely" }]);
		await repo.delete(metadata);
		expect(removals).toEqual([
			expect.objectContaining({ metadata, entry: expect.objectContaining({ id: entryId }) }),
		]);
	});

	it("searches and deletes transactionally indexed canonical entries", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const repo = new SqliteSessionRepo({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath,
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

		await repo.delete(metadata);
		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([]);
	});
});
