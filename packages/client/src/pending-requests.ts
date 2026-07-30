import type { Command, CommandResult, ResultForCommand } from "@earendil-works/pi-protocol";

interface PendingRequest {
	command: Command;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export class PendingRequests {
	readonly #requests = new Map<string, PendingRequest>();
	#sequence = 0;

	create<const TCommand extends Command>(
		command: TCommand,
	): { id: string; promise: Promise<ResultForCommand<TCommand>> } {
		const id = `request-${++this.#sequence}`;
		const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
		this.#requests.set(id, { command, resolve, reject });
		return { id, promise: promise as Promise<ResultForCommand<TCommand>> };
	}

	take(id: string): PendingRequest | undefined {
		const request = this.#requests.get(id);
		if (request) this.#requests.delete(id);
		return request;
	}

	rejectAll(error: Error): void {
		const requests = [...this.#requests.values()];
		this.#requests.clear();
		for (const request of requests) request.reject(error);
	}
}
