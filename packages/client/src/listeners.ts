import { toError } from "./errors.ts";
import type { ListenerErrorHandler } from "./types.ts";

export function notifyListeners<T>(
	listeners: Iterable<(value: T) => void> | undefined,
	value: T,
	onError?: ListenerErrorHandler,
): void {
	for (const listener of listeners ?? []) {
		try {
			listener(value);
		} catch (error) {
			if (!onError) continue;
			try {
				onError(toError(error));
			} catch {
				// Diagnostics cannot affect protocol or transport state.
			}
		}
	}
}
