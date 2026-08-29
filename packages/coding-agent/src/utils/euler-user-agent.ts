export function getEulerUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `euler/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
