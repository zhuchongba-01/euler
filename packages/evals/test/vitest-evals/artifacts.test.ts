import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	getCurrentEvalTest,
	persistEvalArtifactReferences,
	recordEvalExtensionSourceArtifact,
	recordEvalFileArtifact,
} from "../../src/vitest-evals/artifacts.ts";

it("records file and inline Vitest attachments", async ({ task }) => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-artifact-test-"));
	try {
		const runId = "run-1";
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, '{"type":"session"}\n', "utf8");

		const test = getCurrentEvalTest();
		await recordEvalFileArtifact(test, runId, { name: "session", path: sessionPath });
		await recordEvalExtensionSourceArtifact(task, runId, "export default function () {}\n");
		expect(test.artifacts).toContainEqual(
			expect.objectContaining({
				type: "@earendil-works/pi-evals:file",
				runId,
				attachments: [
					expect.objectContaining({
						name: "session",
						path: expect.any(String),
					}),
				],
			}),
		);
		expect(test.artifacts).toContainEqual(
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("persists and selects attachments belonging to the reported run", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-artifact-report-test-"));
	try {
		const references = await persistEvalArtifactReferences(
			[
				{
					type: "@earendil-works/pi-evals:file",
					runId: "run-1",
					attachments: [{ name: "session", path: join(root, "sessions", "run-1.jsonl") }],
				},
				{
					type: "@earendil-works/pi-evals:file",
					runId: "run-2",
					attachments: [{ name: "session", path: "/eval/sessions/run-2.jsonl" }],
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
			{ name: "session", path: "sessions/run-1.jsonl" },
			{ name: "hello.ts", path: expect.stringMatching(/^sources\/[a-f0-9]{64}\/hello\.ts$/) },
		]);
		const source = references.find(({ name }) => name === "hello.ts");
		if (!source) throw new TypeError("Expected a persisted extension source reference.");
		expect(await readFile(join(root, source.path), "utf8")).toBe("export default function () {}\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
