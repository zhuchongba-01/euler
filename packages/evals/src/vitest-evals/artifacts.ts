import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
	type RunnerTestCase,
	recordArtifact,
	type TestArtifact,
	type TestArtifactBase,
	type TestAttachment,
} from "vitest";
import type { HarnessRun } from "vitest-evals/harness";

export const PI_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";

const evalSessionArtifactKey = Symbol("pi-evals-session-artifact");
const evalExtensionSourceArtifactKey = Symbol("pi-evals-extension-source-artifact");

interface EvalTextAttachment extends TestAttachment {
	name: string;
	contentType: string;
	body: string;
	bodyEncoding: "utf-8";
}

interface EvalSessionArtifact extends TestArtifactBase {
	type: "@earendil-works/pi-evals:session";
	runId: string;
	attachments: [EvalTextAttachment] | [];
}

interface EvalExtensionSourceArtifact extends TestArtifactBase {
	type: "@earendil-works/pi-evals:extension-source";
	runId: string;
	attachments: [EvalTextAttachment] | [];
}

declare module "vitest" {
	interface TestArtifactRegistry {
		[evalSessionArtifactKey]: EvalSessionArtifact;
		[evalExtensionSourceArtifactKey]: EvalExtensionSourceArtifact;
	}
}

export async function recordEvalSessionArtifact(
	task: Readonly<RunnerTestCase>,
	run: Pick<HarnessRun, "artifacts">,
): Promise<void> {
	const runId = run.artifacts?.runId;
	const session = run.artifacts?.[PI_SESSION_SNAPSHOT_ARTIFACT];
	if (session === undefined) return;
	if (typeof runId !== "string" || typeof session !== "string") {
		throw new TypeError("Pi eval session artifact metadata is invalid.");
	}
	await recordArtifact(task, {
		type: "@earendil-works/pi-evals:session",
		runId,
		attachments: [
			{
				name: "session.jsonl",
				contentType: "application/x-ndjson",
				body: session,
				bodyEncoding: "utf-8",
			},
		],
	});
}

export async function recordEvalExtensionSourceArtifact(
	task: Readonly<RunnerTestCase>,
	runId: string,
	source: string,
): Promise<void> {
	await recordArtifact(task, {
		type: "@earendil-works/pi-evals:extension-source",
		runId,
		attachments: [
			{
				name: "hello.ts",
				contentType: "text/typescript",
				body: source,
				bodyEncoding: "utf-8",
			},
		],
	});
}

export async function persistEvalArtifactReferences(
	artifacts: ReadonlyArray<TestArtifact>,
	runId: string,
	artifactDirectory: string,
): Promise<Array<{ name: string; path: string }>> {
	const references: Array<{ name: string; path: string }> = [];
	for (const artifact of artifacts) {
		if (
			(artifact.type !== "@earendil-works/pi-evals:session" &&
				artifact.type !== "@earendil-works/pi-evals:extension-source") ||
			artifact.runId !== runId
		) {
			continue;
		}
		const category = artifact.type === "@earendil-works/pi-evals:session" ? "sessions" : "sources";
		for (const attachment of artifact.attachments) {
			const name = basename(attachment.name);
			if (name !== attachment.name) throw new TypeError(`Invalid eval artifact name: ${attachment.name}`);
			const directory = join(artifactDirectory, category, createHash("sha256").update(runId).digest("hex"));
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, name);
			await writeFile(path, attachment.body, { encoding: "utf8", mode: 0o600 });
			references.push({ name, path: relative(artifactDirectory, path) });
		}
	}
	return references;
}
