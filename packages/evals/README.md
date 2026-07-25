# Pi evals

Behavioral evaluations for Pi using `vitest-evals`.

`src/pi-harness.ts` mirrors the upstream `@vitest-evals/harness-pi-ai` implementation, except that it imports Pi AI
from `@earendil-works/pi-ai/compat`. Keep it synchronized with
[`getsentry/vitest-evals`](https://github.com/getsentry/vitest-evals/blob/main/packages/harness-pi-ai/src/index.ts).

Pi's `AgentSession` is the system under test. `src/pi-agent.ts` adapts it to the harness's agent contract, while
`piAiHarness(...)` handles eval execution and trace normalization. Each run uses a temporary workspace that is removed
afterward.

## Running

From the repository root, run with an explicit provider and model:

```bash
npm run eval -- --provider openai-codex --model gpt-5.4
```

When invoked from a Pi Bash tool, the current session supplies `PI_PROVIDER` and `PI_MODEL`, so this is sufficient:

```bash
npm run eval
```

The runner requires both values and never falls back to another model. Additional arguments are forwarded to Vitest, for example:

```bash
npm run eval -- -t "capital of France"
```

Authentication is resolved by Pi's normal `ModelRuntime`. Subscription-backed providers such as `openai-codex` use credentials from the user's Pi configuration. API-backed providers use their standard environment variables, such as `OPENAI_API_KEY` for `openai`.
