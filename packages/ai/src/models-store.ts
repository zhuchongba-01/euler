import type { Api, Model } from "./types.ts";

/** Persistent model catalogs keyed by provider ID. */
export interface ModelsStore {
	read(providerId: string): Promise<readonly Model<Api>[] | undefined>;
	write(providerId: string, models: readonly Model<Api>[]): Promise<void>;
	delete(providerId: string): Promise<void>;
}

/** ModelsStore scoped to one provider. Providers cannot access other providers' catalogs. */
export interface ProviderModelsStore {
	read(): Promise<readonly Model<Api>[] | undefined>;
	write(models: readonly Model<Api>[]): Promise<void>;
	delete(): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly models = new Map<string, readonly Model<Api>[]>();

	async read(providerId: string): Promise<readonly Model<Api>[] | undefined> {
		const models = this.models.get(providerId);
		return models?.map((model) => structuredClone(model));
	}

	async write(providerId: string, models: readonly Model<Api>[]): Promise<void> {
		this.models.set(
			providerId,
			models.map((model) => structuredClone(model)),
		);
	}

	async delete(providerId: string): Promise<void> {
		this.models.delete(providerId);
	}
}
