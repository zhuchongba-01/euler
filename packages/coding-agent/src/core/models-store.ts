import { join } from "node:path";
import type { Api, Model, ModelsStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

type StoredModels = Record<string, Model<Api>[]>;

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly models = new Map<string, readonly Model<Api>[]>();

	async read(providerId: string): Promise<readonly Model<Api>[] | undefined> {
		return this.models.get(providerId);
	}

	async write(providerId: string, models: readonly Model<Api>[]): Promise<void> {
		this.models.set(providerId, models);
	}

	async delete(providerId: string): Promise<void> {
		this.models.delete(providerId);
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(content) as StoredModels) : {};
	}

	async read(providerId: string): Promise<readonly Model<Api>[] | undefined> {
		return this.storage.withLock((content) => ({
			result: this.parse(content)[providerId]?.map((model) => structuredClone(model)),
		}));
	}

	async write(providerId: string, models: readonly Model<Api>[]): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = models.map((model) => structuredClone(model));
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}
}
