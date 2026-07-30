export function notifyListeners<T>(listeners: Iterable<(value: T) => void> | undefined, value: T): void {
	for (const listener of listeners ?? []) {
		try {
			listener(value);
		} catch {
			// Consumer callbacks cannot affect protocol or transport state.
		}
	}
}
