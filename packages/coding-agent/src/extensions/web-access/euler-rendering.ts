export interface EulerSearchRenderSource {
	title: string;
	url: string;
}

export interface EulerSearchRenderData {
	provider?: string | null;
	totalResults?: number;
	summary?: string | null;
	sources?: EulerSearchRenderSource[];
}

function removeTerminalControls(value: string): string {
	let output = "";
	let inEscapeSequence = false;
	let stringEscape = false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (stringEscape) {
			if (code === 7) stringEscape = false;
			else if (code === 27 && value.charCodeAt(index + 1) === 92) {
				stringEscape = false;
				index++;
			}
			continue;
		}
		if (inEscapeSequence) {
			if (code === 93 || code === 80 || code === 94 || code === 95) {
				stringEscape = true;
				inEscapeSequence = false;
				continue;
			}
			if (code >= 64 && code <= 126) inEscapeSequence = false;
			continue;
		}
		if (code === 27) {
			inEscapeSequence = true;
			continue;
		}
		if (code < 32 && code !== 9 && code !== 10) continue;
		if (code >= 127 && code <= 159) continue;
		output += value[index];
	}
	return output;
}

function safeLine(value: string | null | undefined, maxLength: number): string {
	return removeTerminalControls(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}

export function formatEulerSearchResult(data: EulerSearchRenderData, expanded: boolean): string {
	const provider = safeLine(data.provider || "unknown", 40);
	const resultCount = Math.max(0, data.totalResults ?? data.sources?.length ?? 0);
	const sources = (data.sources ?? []).map((source) => ({
		title: safeLine(source.title, 120),
		url: safeLine(source.url, 2_048),
	}));
	const summary = safeLine(data.summary, expanded ? 2_000 : 240);
	const lines = [`${provider} · ${resultCount} results · ${sources.length} sources`];
	if (summary) lines.push(summary);
	if (expanded) {
		for (const source of sources) {
			lines.push(`- ${source.title || "Untitled"}`);
			lines.push(`  ${source.url}`);
		}
	}
	return lines.join("\n");
}
