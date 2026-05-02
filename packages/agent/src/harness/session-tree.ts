import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "../types.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionInfoEntry,
	SessionTree,
	SessionTreeEntry,
	SessionTreeStorage,
	ThinkingLevelChangeEntry,
} from "./types.js";

function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}

export function buildSessionContext(entries: SessionTreeEntry[]): SessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of entries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionTreeEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
		const compactionIdx = entries.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = entries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(entry);
		}
		for (let i = compactionIdx + 1; i < entries.length; i++) {
			appendMessage(entries[i]!);
		}
	} else {
		for (const entry of entries) {
			appendMessage(entry);
		}
	}

	return { messages, thinkingLevel, model };
}

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

async function loadJsonlStorage(
	filePath: string,
): Promise<{ header?: SessionHeader; entries: SessionTreeEntry[]; leafId: string | null }> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries: SessionTreeEntry[] = [];
		let header: SessionHeader | undefined;
		let leafId: string | null = null;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as SessionHeader | SessionTreeEntry;
				if (record.type === "session") {
					header = record as SessionHeader;
					continue;
				}
				entries.push(record as SessionTreeEntry);
				leafId = (record as SessionTreeEntry).id;
			} catch {
				// ignore malformed lines
			}
		}
		return { header, entries, leafId };
	} catch {
		return { entries: [], leafId: null };
	}
}

export class JsonlSessionTreeStorage implements SessionTreeStorage {
	private filePath: string;
	private cwd: string;
	private headerInitialized = false;
	private cacheLoaded = false;
	private entries: SessionTreeEntry[] = [];
	private byId = new Map<string, SessionTreeEntry>();
	private currentLeafId: string | null = null;

	constructor(filePath: string, options: { cwd: string }) {
		this.filePath = resolve(filePath);
		this.cwd = options.cwd;
	}

	private async ensureParentDir(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
	}

	private async ensureLoaded(): Promise<void> {
		if (this.cacheLoaded) {
			return;
		}
		const loaded = await loadJsonlStorage(this.filePath);
		this.entries = loaded.entries;
		this.byId = new Map(loaded.entries.map((entry) => [entry.id, entry]));
		this.currentLeafId = loaded.leafId;
		this.headerInitialized = loaded.header !== undefined;
		this.cacheLoaded = true;
	}

	private async ensureHeader(): Promise<void> {
		await this.ensureLoaded();
		if (this.headerInitialized) return;
		await this.ensureParentDir();
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: this.cwd,
		};
		await writeFile(this.filePath, `${JSON.stringify(header)}\n`);
		this.headerInitialized = true;
	}

	async getLeafId(): Promise<string | null> {
		await this.ensureLoaded();
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		await this.ensureLoaded();
		this.currentLeafId = leafId;
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.ensureHeader();
		await appendFile(this.filePath, `${JSON.stringify(entry)}\n`);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.currentLeafId = entry.id;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		await this.ensureLoaded();
		return this.byId.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		await this.ensureLoaded();
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current = this.byId.get(leafId);
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		await this.ensureLoaded();
		return [...this.entries];
	}
}

export class InMemorySessionTreeStorage implements SessionTreeStorage {
	private entries: SessionTreeEntry[];
	private leafId: string | null;

	constructor(options?: { entries?: SessionTreeEntry[]; leafId?: string | null }) {
		this.entries = options?.entries ? [...options.entries] : [];
		this.leafId = options?.leafId ?? this.entries[this.entries.length - 1]?.id ?? null;
	}

	async getLeafId(): Promise<string | null> {
		return this.leafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		this.leafId = leafId;
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		this.entries.push(entry);
		this.leafId = entry.id;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.entries.find((entry) => entry.id === id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const byId = new Map<string, SessionTreeEntry>(this.entries.map((entry) => [entry.id, entry]));
		const path: SessionTreeEntry[] = [];
		let current = byId.get(leafId);
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}

export class DefaultSessionTree implements SessionTree {
	private storage: SessionTreeStorage;

	constructor(storage?: SessionTreeStorage) {
		this.storage = storage ?? new InMemorySessionTreeStorage();
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	getEntries(): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries();
	}

	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const leafId = fromId ?? (await this.storage.getLeafId());
		return this.storage.getPathToRoot(leafId);
	}

	async buildContext(): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch());
	}

	private async makeEntryId(): Promise<string> {
		const entries = await this.storage.getEntries();
		return generateId(new Set(entries.map((entry) => entry.id)));
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	async appendBranchSummary<T = unknown>(
		fromId: string,
		summary: string,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			fromHook,
		} satisfies BranchSummaryEntry<T>);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	async appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.appendTypedEntry({
			type: "label",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	async appendSessionInfo(name: string): Promise<string> {
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.makeEntryId(),
			parentId: await this.storage.getLeafId(),
			timestamp: new Date().toISOString(),
			name: name.trim(),
		} satisfies SessionInfoEntry);
	}

	async moveTo(entryId: string | null): Promise<void> {
		if (entryId !== null && !(await this.storage.getEntry(entryId))) {
			throw new Error(`Entry ${entryId} not found`);
		}
		await this.storage.setLeafId(entryId);
	}
}
