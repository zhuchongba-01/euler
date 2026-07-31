import type {
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchIndex,
	SessionSearchOptions,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { getFileSystemResultOrThrow } from "@earendil-works/pi-agent-core";
import { rowToMetadata, type SessionRow } from "./storage/sessions.ts";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteSessionStoreEnv } from "./types.ts";

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

async function configureSqliteDatabase(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=FULL");
	await db.exec("PRAGMA busy_timeout=5000");
}

type SearchSchemaMode = "standalone" | "canonical";

async function tableExists(db: SqliteDatabase, name: string): Promise<boolean> {
	return !!(await db
		.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get<{ found: number }>(name));
}

async function ensureSearchSchema(db: SqliteDatabase): Promise<SearchSchemaMode> {
	if (await tableExists(db, "session_entries")) {
		const ftsExists = await tableExists(db, "session_search_fts");
		await db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
  payload,
  content = 'session_entries',
  content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS session_search_fts_ai AFTER INSERT ON session_entries BEGIN
  INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
CREATE TRIGGER IF NOT EXISTS session_search_fts_ad AFTER DELETE ON session_entries BEGIN
  INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
END;
CREATE TRIGGER IF NOT EXISTS session_search_fts_au AFTER UPDATE OF payload ON session_entries BEGIN
  INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
  INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
`);
		if (!ftsExists) await db.exec("INSERT INTO session_search_fts(session_search_fts) VALUES('rebuild')");
		return "canonical";
	}

	await db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
  session_id UNINDEXED,
  entry_id UNINDEXED,
  timestamp UNINDEXED,
  cwd UNINDEXED,
  metadata_json UNINDEXED,
  search_text,
  tokenize = 'trigram remove_diacritics 1'
);
`);
	return "standalone";
}

/**
 * Storage-independent SQLite FTS search. Its database may be separate from,
 * or shared with, the canonical session backend.
 */
export class SqliteSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>, SessionSearchIndex<TMetadata>
{
	private readonly options: {
		env: Pick<SqliteSessionStoreEnv, "absolutePath" | "createDir">;
		sqlite: SqliteDatabaseFactory;
		databasePath: string;
	};
	private databasePath: string | undefined;

	constructor(options: {
		env: Pick<SqliteSessionStoreEnv, "absolutePath" | "createDir">;
		sqlite: SqliteDatabaseFactory;
		databasePath: string;
	}) {
		this.options = options;
	}

	private async getDatabasePath(): Promise<string> {
		if (!this.databasePath) {
			this.databasePath = getFileSystemResultOrThrow(
				await this.options.env.absolutePath(this.options.databasePath),
				`Failed to resolve SQLite search database ${this.options.databasePath}`,
			);
		}
		return this.databasePath;
	}

	private async openDatabase(): Promise<{ db: SqliteDatabase; schemaMode: SearchSchemaMode }> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.options.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite search directory ${directory}`,
		);
		const db = await this.options.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			const schemaMode = await ensureSearchSchema(db);
			return { db, schemaMode };
		} catch (error) {
			await db.close();
			throw error;
		}
	}

	async upsertEntry(metadata: TMetadata, entry: SessionTreeEntry): Promise<void> {
		const { db, schemaMode } = await this.openDatabase();
		try {
			if (schemaMode === "canonical") return;
			const cwd = (metadata as { cwd?: unknown }).cwd;
			const sessionId = metadata.id;
			const entryId = entry.id;
			const timestamp = entry.timestamp;
			const metadataJson = JSON.stringify(metadata);
			const searchText = JSON.stringify(entry);
			await db.transaction(async () => {
				await db
					.prepare("DELETE FROM session_search_fts WHERE session_id = ? AND entry_id = ?")
					.run(sessionId, entryId);
				await db
					.prepare(
						"INSERT INTO session_search_fts (session_id, entry_id, timestamp, cwd, metadata_json, search_text) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(sessionId, entryId, timestamp, typeof cwd === "string" ? cwd : null, metadataJson, searchText);
			});
		} finally {
			await db.close();
		}
	}

	async replaceSession(metadata: TMetadata, entries: readonly SessionTreeEntry[]): Promise<void> {
		const { db, schemaMode } = await this.openDatabase();
		try {
			if (schemaMode === "canonical") return;
			const cwd = (metadata as { cwd?: unknown }).cwd;
			const sessionId = metadata.id;
			const metadataJson = JSON.stringify(metadata);
			await db.transaction(async () => {
				await db.prepare("DELETE FROM session_search_fts WHERE session_id = ?").run(sessionId);
				for (const entry of entries) {
					await db
						.prepare(
							"INSERT INTO session_search_fts (session_id, entry_id, timestamp, cwd, metadata_json, search_text) VALUES (?, ?, ?, ?, ?, ?)",
						)
						.run(
							sessionId,
							entry.id,
							entry.timestamp,
							typeof cwd === "string" ? cwd : null,
							metadataJson,
							JSON.stringify(entry),
						);
				}
			});
		} finally {
			await db.close();
		}
	}

	async deleteSession(metadata: TMetadata): Promise<void> {
		const { db, schemaMode } = await this.openDatabase();
		try {
			if (schemaMode === "canonical") return;
			await db.prepare("DELETE FROM session_search_fts WHERE session_id = ?").run(metadata.id);
		} finally {
			await db.close();
		}
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const text = options.text.trim();
		if (!text) return [];
		const { db, schemaMode } = await this.openDatabase();
		try {
			const query = `"${text.replaceAll('"', '""')}"`;
			if (schemaMode === "canonical") {
				const rows = await db
					.prepare(
						"SELECT s.id, s.created_at, s.metadata, s.cwd, s.parent_session_id, s.active_leaf_id, se.id AS entry_id, se.timestamp, bm25(session_search_fts) AS score FROM session_search_fts JOIN session_entries se ON se.rowid = session_search_fts.rowid JOIN sessions s ON s.id = se.session_id WHERE session_search_fts MATCH ? AND (? IS NULL OR s.cwd = ?) ORDER BY score",
					)
					.all<SessionRow & { entry_id: string; timestamp: string; score: number }>(
						query,
						options.cwd ?? null,
						options.cwd ?? null,
					);
				const path = await this.getDatabasePath();
				return rows.map((row) => ({
					metadata: rowToMetadata(row, path) as unknown as TMetadata,
					entryId: row.entry_id,
					timestamp: row.timestamp,
					score: row.score,
				}));
			}
			const rows = await db
				.prepare(
					"SELECT metadata_json, entry_id, timestamp, bm25(session_search_fts) AS score FROM session_search_fts WHERE session_search_fts MATCH ? AND (? IS NULL OR cwd = ?) ORDER BY score",
				)
				.all<{ metadata_json: string; entry_id: string; timestamp: string; score: number }>(
					query,
					options.cwd ?? null,
					options.cwd ?? null,
				);
			return rows.map((row) => ({
				metadata: JSON.parse(row.metadata_json) as TMetadata,
				entryId: row.entry_id,
				timestamp: row.timestamp,
				score: row.score,
			}));
		} finally {
			await db.close();
		}
	}
}
