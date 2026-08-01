import type { SessionEntryCursorOptions, SessionReader, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { SessionError, toError } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";
import { decodeEntry, encodeEntry, type SessionEntryRow } from "./session-entries.ts";
import {
	applyEntryToMaterializedState,
	createEmptyMaterializedState,
	type EntryMaterializedRow,
	entryMaterializedValues,
	materializedStateFromRows,
	materializedStateValues,
	type SessionMaterializedRow,
	type SessionMaterializedState,
	serializeSummary,
} from "./session-materialized.ts";
import { advanceSequence, getNextSequence } from "./session-sequences.ts";
import { rowToMetadata, type SessionRow } from "./sessions.ts";
import { invalidEntry, invalidSession, leafIdAfterEntry } from "./shared.ts";

function decodeEntryRows(entryRows: SessionEntryRow[]): SessionTreeEntry[] {
	const entries: SessionTreeEntry[] = [];
	for (const entryRow of entryRows) {
		try {
			const entry = decodeEntry(entryRow);
			entries.push(entry);
		} catch (error) {
			throw invalidEntry(`failed to decode entry ${entryRow.id}`, toError(error));
		}
	}
	return entries;
}

async function loadEntryRowsByIds(
	db: SqliteDatabase,
	sessionId: string,
	entryIds: string[],
): Promise<Map<string, SessionEntryRow>> {
	if (entryIds.length === 0) return new Map<string, SessionEntryRow>();
	const placeholders = entryIds.map(() => "?").join(", ");
	const rows = await db
		.prepare(
			`SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id IN (${placeholders})`,
		)
		.all<SessionEntryRow>(sessionId, ...entryIds);
	return new Map(rows.map((row) => [row.id, row]));
}

async function loadActiveBranchId(db: SqliteDatabase, sessionId: string): Promise<string | null> {
	// branch_entries includes leaf navigation entries for the active branch, so the
	// newest branch_entries row identifies the branch that was most recently made active.
	const row = await db
		.prepare(
			"SELECT branch_id FROM branch_entries WHERE session_id = ? ORDER BY entry_seq DESC, branch_id DESC LIMIT 1",
		)
		.get<{ branch_id: string }>(sessionId);
	return row?.branch_id ?? null;
}

async function hasExistingChild(db: SqliteDatabase, sessionId: string, parentId: string | null): Promise<boolean> {
	const row =
		parentId === null
			? await db
					.prepare("SELECT 1 AS found FROM session_entries WHERE session_id = ? AND parent_id IS NULL LIMIT 1")
					.get<{ found: number }>(sessionId)
			: await db
					.prepare("SELECT 1 AS found FROM session_entries WHERE session_id = ? AND parent_id = ? LIMIT 1")
					.get<{ found: number }>(sessionId, parentId);
	return row !== undefined;
}

async function loadSqliteSession(
	db: SqliteDatabase,
	sessionId: string,
): Promise<{
	row: SessionRow;
	activeBranchId: string | null;
	materializedState: SessionMaterializedState;
}> {
	const row = await db
		.prepare("SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE id = ?")
		.get<SessionRow>(sessionId);
	if (!row) throw new SessionError("not_found", `Session not found: ${sessionId}`);

	const materializedRow = await db
		.prepare("SELECT session_id, payload FROM session_materialized WHERE session_id = ?")
		.get<SessionMaterializedRow>(sessionId);
	if (!materializedRow) throw invalidSession(`missing materialized row for session ${sessionId}`);
	const entryMaterializedRows = await db
		.prepare(
			"SELECT session_id, entry_seq, type, payload FROM entry_materialized WHERE session_id = ? ORDER BY entry_seq, type",
		)
		.all<EntryMaterializedRow>(sessionId);
	return {
		row,
		activeBranchId: await loadActiveBranchId(db, sessionId),
		materializedState: materializedStateFromRows(materializedRow, entryMaterializedRows),
	};
}

export class SqliteSessionConnection implements SessionReader<SqliteSessionMetadata> {
	private readonly db: SqliteDatabase;
	readonly metadata: SqliteSessionMetadata;
	private byId: Map<string, SessionTreeEntry>;
	private activeBranchId: string | null;
	private materializedState: SessionMaterializedState;

	async readPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = await this.readEntry(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.push(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = await this.readEntry(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path.reverse();
	}

	private async materializeBranch(leafId: string | null): Promise<string> {
		const branchId = uuidv7();
		// Rebuild the branch path only when branch membership changes: branch switch
		// (leaf navigation) or a new fork from a parent that already has a child.
		// Linear appends stay cheap and extend the active branch incrementally.
		const path = await this.readPathToRootOrCompaction(leafId);
		const entryRowsById = await loadEntryRowsByIds(
			this.db,
			this.metadata.id,
			path.map((entry) => entry.id),
		);
		for (const entry of path) {
			const entryRow = entryRowsById.get(entry.id);
			if (!entryRow) throw invalidSession(`missing entry row for session ${this.metadata.id} entry ${entry.id}`);
			await this.db
				.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
				.run(this.metadata.id, branchId, entry.id, entryRow.entry_seq);
		}
		return branchId;
	}

	private async appendToActiveBranch(
		entryId: string,
		parentId: string | null,
		activeBranchId: string | null,
	): Promise<string> {
		let branchId = activeBranchId;
		// Reuse the staged active branch when available. Otherwise materialize
		// the parent path once, then add only the new tip entry below.
		if (!branchId) branchId = await this.materializeBranch(parentId);
		const entryRow = await this.db
			.prepare("SELECT entry_seq FROM session_entries WHERE session_id = ? AND id = ?")
			.get<{ entry_seq: number }>(this.metadata.id, entryId);
		if (!entryRow) throw invalidSession(`missing entry row for session ${this.metadata.id} entry ${entryId}`);
		await this.db
			.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
			.run(this.metadata.id, branchId, entryId, entryRow.entry_seq);
		return branchId;
	}

	private constructor(
		db: SqliteDatabase,
		metadata: SqliteSessionMetadata,
		activeBranchId: string | null,
		materializedState: SessionMaterializedState,
	) {
		this.db = db;
		this.metadata = metadata;
		this.byId = new Map<string, SessionTreeEntry>();
		this.materializedState = materializedState;
		this.activeBranchId = activeBranchId;
	}

	static async open(db: SqliteDatabase, metadata: SqliteSessionMetadata): Promise<SqliteSessionConnection> {
		const loaded = await loadSqliteSession(db, metadata.id);
		return new SqliteSessionConnection(
			db,
			rowToMetadata(loaded.row, metadata.path),
			loaded.activeBranchId,
			loaded.materializedState,
		);
	}

	static async create(
		db: SqliteDatabase,
		path: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionId?: string;
			metadata?: Record<string, unknown>;
		},
	): Promise<SqliteSessionConnection> {
		const createdAt = new Date().toISOString();
		await db
			.prepare(
				"INSERT INTO sessions (id, created_at, metadata, cwd, parent_session_id, active_leaf_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				options.sessionId,
				createdAt,
				options.metadata === undefined ? null : JSON.stringify(options.metadata),
				options.cwd,
				options.parentSessionId ?? null,
				null,
			);
		await db.prepare("INSERT INTO session_sequences (session_id, next_seq) VALUES (?, ?)").run(options.sessionId, 1);
		await db
			.prepare("INSERT INTO session_materialized (session_id, payload) VALUES (?, ?)")
			.run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));
		return new SqliteSessionConnection(
			db,
			{
				id: options.sessionId,
				createdAt,
				cwd: options.cwd,
				path,
				parentSessionId: options.parentSessionId,
				metadata: options.metadata,
			},
			null,
			createEmptyMaterializedState(),
		);
	}

	async readHead(): Promise<{ leafId: string | null }> {
		const row = await this.db
			.prepare(
				`SELECT
					s.active_leaf_id,
					(s.active_leaf_id IS NULL OR EXISTS (
						SELECT 1 FROM session_entries AS e WHERE e.session_id = s.id AND e.id = s.active_leaf_id
					)) AS active_leaf_exists
				FROM sessions AS s
				WHERE s.id = ?`,
			)
			.get<{ active_leaf_id: string | null; active_leaf_exists: number }>(this.metadata.id);
		if (!row) throw new SessionError("not_found", `Session not found: ${this.metadata.id}`);
		if (row.active_leaf_exists === 0) {
			throw new SessionError("invalid_session", `Entry ${row.active_leaf_id} not found`);
		}
		return { leafId: row.active_leaf_id };
	}

	async appendEntry(entry: SessionTreeEntry, options: { transaction?: boolean } = {}): Promise<void> {
		const encoded = encodeEntry(entry);
		const nextMaterializedState: SessionMaterializedState = {
			...this.materializedState,
			labelsById: new Map(this.materializedState.labelsById),
			modelThinkingConfigs: [...this.materializedState.modelThinkingConfigs],
			currentModel: this.materializedState.currentModel ? { ...this.materializedState.currentModel } : null,
		};
		const nextLeafId = leafIdAfterEntry(entry);
		let nextActiveBranchId = this.activeBranchId;
		try {
			applyEntryToMaterializedState(nextMaterializedState, entry);
			const write = async () => {
				const parentHadExistingChild = await hasExistingChild(this.db, this.metadata.id, entry.parentId);
				const nextSeq = await getNextSequence(this.db, this.metadata.id);
				await this.db
					.prepare(
						"INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(this.metadata.id, entry.id, nextSeq, entry.parentId, entry.type, entry.timestamp, encoded.payload);
				await advanceSequence(this.db, this.metadata.id, nextSeq);
				await this.db
					.prepare("UPDATE session_materialized SET payload = ? WHERE session_id = ?")
					.run(serializeSummary(nextMaterializedState), this.metadata.id);
				for (const materializedEntry of entryMaterializedValues(entry)) {
					await this.db
						.prepare("INSERT INTO entry_materialized (session_id, entry_seq, type, payload) VALUES (?, ?, ?, ?)")
						.run(this.metadata.id, nextSeq, materializedEntry.type, materializedEntry.payload);
				}
				await this.db
					.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?")
					.run(nextLeafId, this.metadata.id);
				if (entry.type === "leaf") {
					nextActiveBranchId = await this.materializeBranch(entry.targetId);
					nextActiveBranchId = await this.appendToActiveBranch(entry.id, entry.parentId, nextActiveBranchId);
				} else {
					if (parentHadExistingChild) {
						nextActiveBranchId = await this.materializeBranch(entry.parentId);
					}
					nextActiveBranchId = await this.appendToActiveBranch(entry.id, entry.parentId, nextActiveBranchId);
				}
			};
			if (options.transaction === false) await write();
			else await this.db.transaction(write);
			this.materializedState = nextMaterializedState;
			this.byId.set(entry.id, entry);
			this.activeBranchId = nextActiveBranchId;
		} catch (error) {
			if (error instanceof SessionError) throw error;
			throw new SessionError("storage", `Failed to append SQLite session entry ${entry.id}`, toError(error));
		}
	}

	async readEntry(id: string): Promise<SessionTreeEntry | undefined> {
		const cached = this.byId.get(id);
		if (cached) return cached;
		const row = await this.db
			.prepare(
				"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND id = ?",
			)
			.get<SessionEntryRow>(this.metadata.id, id);
		if (!row) return undefined;
		try {
			const entry = decodeEntry(row);
			this.byId.set(entry.id, entry);
			return entry;
		} catch (error) {
			throw invalidEntry(`failed to decode entry ${row.id}`, toError(error));
		}
	}

	async readEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		const afterEntrySeq = options?.afterEntrySeq ?? 0;
		const rows =
			options?.limit === undefined
				? await this.db
						.prepare(
							"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND entry_seq > ? ORDER BY entry_seq",
						)
						.all<SessionEntryRow>(this.metadata.id, afterEntrySeq)
				: await this.db
						.prepare(
							"SELECT session_id, id, entry_seq, parent_id, type, timestamp, payload FROM session_entries WHERE session_id = ? AND entry_seq > ? ORDER BY entry_seq LIMIT ?",
						)
						.all<SessionEntryRow>(this.metadata.id, afterEntrySeq, options.limit);
		const entries = decodeEntryRows(rows);
		for (const entry of entries) {
			this.byId.set(entry.id, entry);
		}
		return entries;
	}
}
