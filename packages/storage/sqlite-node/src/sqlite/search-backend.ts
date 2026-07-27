import type {
	SessionSearchBackend,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
} from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
import { rowToMetadata, type SessionRow } from "./storage/sessions.ts";
import type { SqliteDatabase, SqliteSessionMetadata } from "./types.ts";

/** SQLite-backed search backend for persisted session entries. */
export class SqliteSessionSearchBackend implements SessionSearchBackend<SqliteSessionMetadata> {
	private readonly db: SqliteDatabase;
	private readonly databasePath: string;

	constructor(db: SqliteDatabase, databasePath: string) {
		this.db = db;
		this.databasePath = databasePath;
	}

	async upsert(record: SessionSearchRecord<SqliteSessionMetadata>): Promise<void> {
		const row = await this.db
			.prepare("SELECT rowid FROM session_entries WHERE session_id = ? AND id = ?")
			.get<{ rowid: number }>(record.metadata.id, record.entry.id);
		if (!row) {
			throw new SessionError("not_found", `Entry ${record.entry.id} not found for search persistence`);
		}
		await this.db
			.prepare("INSERT INTO session_entry_search_fts (rowid, search_text) VALUES (?, ?)")
			.run(row.rowid, JSON.stringify(record.entry));
	}

	async remove(record: SessionSearchRecord<SqliteSessionMetadata>): Promise<void> {
		const row = await this.db
			.prepare("SELECT rowid FROM session_entries WHERE session_id = ? AND id = ?")
			.get<{ rowid: number }>(record.metadata.id, record.entry.id);
		if (!row) return;
		await this.db
			.prepare(
				"INSERT INTO session_entry_search_fts(session_entry_search_fts, rowid, search_text) VALUES ('delete', ?, ?)",
			)
			.run(row.rowid, JSON.stringify(record.entry));
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
		const text = options.text.trim();
		if (!text) return [];
		const query = `"${text.replaceAll('"', '""')}"`;
		const rows = await this.db
			.prepare(
				"SELECT sessions.id, sessions.created_at, sessions.metadata, sessions.cwd, sessions.parent_session_id, sessions.active_leaf_id, session_entries.id AS entry_id, session_entries.timestamp, bm25(session_entry_search_fts) AS score FROM session_entry_search_fts JOIN session_entries ON session_entries.rowid = session_entry_search_fts.rowid JOIN sessions ON sessions.id = session_entries.session_id WHERE session_entry_search_fts MATCH ? AND (? IS NULL OR sessions.cwd = ?) ORDER BY score",
			)
			.all<SessionRow & { entry_id: string; timestamp: string; score: number }>(
				query,
				options.cwd ?? null,
				options.cwd ?? null,
			);
		return rows.map((row) => ({
			metadata: rowToMetadata(row, this.databasePath),
			entryId: row.entry_id,
			timestamp: row.timestamp,
			score: row.score,
		}));
	}
}
