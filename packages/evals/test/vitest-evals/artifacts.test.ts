import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	persistEvalArtifactReferences,
	recordEvalExtensionSourceArtifact,
	recordEvalSessionArtifact,
} from "../../src/vitest-evals/artifacts.ts";

it("records session and extension source artifacts against the explicit test task", async ({ task }) => {
	const runId = "run-1";
	await recordEvalSessionArtifact(task, {
		artifacts: { runId, piSessionJsonl: '{"type":"session"}\n' },
	});
	await recordEvalExtensionSourceArtifact(task, runId, "export default function () {}\n");

	expect(task.artifacts).toContainEqual(
		expect.objectContaining({
			type: "@earendil-works/pi-evals:session",
			runId,
			attachments: [
				expect.objectContaining({
					name: "session.jsonl",
					body: '{"type":"session"}\n',
					bodyEncoding: "utf-8",
					contentType: "application/jsonl",
				}),
			],
		}),
	);
	expect(task.artifacts).toContainEqual(
		expect.objectContaining({
			type: "@earendil-works/pi-evals:extension-source",
			runId,
			attachments: [
				expect.objectContaining({
					name: "hello.ts",
					body: "export default function () {}\n",
					bodyEncoding: "utf-8",
					contentType: "text/typescript",
				}),
			],
		}),
	);
});

it("persists and selects attachments belonging to the reported run", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-artifact-report-test-"));
	try {
		const references = await persistEvalArtifactReferences(
			[
				{
					type: "@earendil-works/pi-evals:session",
					runId: "run-1",
					attachments: [
						{
							name: "session.jsonl",
							body: '{"type":"session"}\n',
							bodyEncoding: "utf-8",
							contentType: "application/jsonl",
						},
					],
				},
				{
					type: "@earendil-works/pi-evals:session",
					runId: "run-2",
					attachments: [],
				},
				{
					type: "@earendil-works/pi-evals:extension-source",
					runId: "run-1",
					attachments: [
						{
							name: "hello.ts",
							body: "export default function () {}\n",
							bodyEncoding: "utf-8",
							contentType: "text/typescript",
						},
					],
				},
				{ type: "internal:annotation", annotation: { message: "other", type: "info" } },
			],
			"run-1",
			root,
		);
		expect(references).toEqual([
			{ name: "session.jsonl", path: expect.stringMatching(/^sessions\/[a-f0-9]{64}\/session\.jsonl$/) },
			{ name: "hello.ts", path: expect.stringMatching(/^sources\/[a-f0-9]{64}\/hello\.ts$/) },
		]);
		for (const { name, path } of references) {
			const expected = name === "session.jsonl" ? '{"type":"session"}\n' : "export default function () {}\n";
			expect(await readFile(join(root, path), "utf8")).toBe(expected);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
