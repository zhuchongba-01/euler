import type {
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { getFileSystemResultOrThrow } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteSessionRepoEnv } from "./types.ts";

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

async function ensureSearchSchema(db: SqliteDatabase): Promise<void> {
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
}

/**
 * Storage-independent SQLite FTS search. Its database may be separate from,
 * or shared with, the canonical session backend.
 */
export class SqliteSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>
{
	private readonly options: {
		env: Pick<SqliteSessionRepoEnv, "absolutePath" | "createDir">;
		sqlite: SqliteDatabaseFactory;
		databasePath: string;
	};
	private databasePath: string | undefined;

	constructor(options: {
		env: Pick<SqliteSessionRepoEnv, "absolutePath" | "createDir">;
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

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.options.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite search directory ${directory}`,
		);
		const db = await this.options.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			await ensureSearchSchema(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}

	async upsert(record: SessionSearchRecord<TMetadata>): Promise<void> {
		const db = await this.openDatabase();
		try {
			const cwd = (record.metadata as { cwd?: unknown }).cwd;
			const sessionId = record.metadata.id;
			const entryId = record.entry.id;
			const timestamp = record.entry.timestamp;
			const metadataJson = JSON.stringify(record.metadata);
			const searchText = JSON.stringify(record.entry);
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

	async indexSession(metadata: TMetadata, entries: readonly SessionTreeEntry[]): Promise<void> {
		for (const entry of entries) {
			await this.upsert({ metadata, entry });
		}
	}

	async removeSession(metadata: TMetadata): Promise<void> {
		const db = await this.openDatabase();
		try {
			await db.prepare("DELETE FROM session_search_fts WHERE session_id = ?").run(metadata.id);
		} finally {
			await db.close();
		}
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const text = options.text.trim();
		if (!text) return [];
		const db = await this.openDatabase();
		try {
			const query = `"${text.replaceAll('"', '""')}"`;
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
