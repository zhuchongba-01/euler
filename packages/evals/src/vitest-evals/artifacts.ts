import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	type RunnerTestCase,
	recordArtifact,
	type TestArtifact,
	type TestArtifactBase,
	type TestAttachment,
	TestRunner,
} from "vitest";

const evalFileArtifactKey = Symbol("pi-evals-file-artifact");
const evalExtensionSourceArtifactKey = Symbol("pi-evals-extension-source-artifact");

export interface EvalFileAttachment extends TestAttachment {
	name: string;
	path: string;
}

interface EvalExtensionSourceAttachment extends TestAttachment {
	name: string;
	contentType: "text/typescript";
	body: string;
	bodyEncoding: "utf-8";
}

interface EvalFileArtifact extends TestArtifactBase {
	type: "@earendil-works/pi-evals:file";
	runId: string;
	attachments: EvalFileAttachment[];
}

interface EvalExtensionSourceArtifact extends TestArtifactBase {
	type: "@earendil-works/pi-evals:extension-source";
	runId: string;
	attachments: [EvalExtensionSourceAttachment] | [];
}

declare module "vitest" {
	interface TestArtifactRegistry {
		[evalFileArtifactKey]: EvalFileArtifact;
		[evalExtensionSourceArtifactKey]: EvalExtensionSourceArtifact;
	}
}

export function getCurrentEvalTest(): NonNullable<ReturnType<typeof TestRunner.getCurrentTest>> {
	const test = TestRunner.getCurrentTest();
	if (!test) throw new Error("Cannot record an eval artifact outside a running Vitest test.");
	return test;
}

export async function recordEvalFileArtifact(
	test: NonNullable<ReturnType<typeof TestRunner.getCurrentTest>>,
	runId: string,
	attachment: EvalFileAttachment,
): Promise<void> {
	await recordArtifact(test, {
		type: "@earendil-works/pi-evals:file",
		runId,
		attachments: [attachment],
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
		if (artifact.type === "@earendil-works/pi-evals:file" && artifact.runId === runId) {
			for (const attachment of artifact.attachments) {
				references.push({
					name: attachment.name,
					path: isAbsolute(attachment.path) ? relative(artifactDirectory, attachment.path) : attachment.path,
				});
			}
		} else if (artifact.type === "@earendil-works/pi-evals:extension-source" && artifact.runId === runId) {
			for (const attachment of artifact.attachments) {
				const name = basename(attachment.name);
				if (name !== attachment.name) throw new TypeError(`Invalid eval artifact name: ${attachment.name}`);
				const directory = join(artifactDirectory, "sources", createHash("sha256").update(runId).digest("hex"));
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const path = join(directory, name);
				await writeFile(path, attachment.body, { encoding: "utf8", mode: 0o600 });
				references.push({ name, path: relative(artifactDirectory, path) });
			}
		}
	}
	return references;
}
