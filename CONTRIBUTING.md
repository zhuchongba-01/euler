# Contributing to Euler

This guide exists to save both sides time.

## What Euler Is

Euler is a downstream distribution of the [Pi agent harness](https://github.com/earendil-works/pi). The core stays minimal and tracks upstream; Euler-specific work lives in the branding layer, config isolation, system prompt, built-in web access, and release tooling. Read [docs/upstream.md](docs/upstream.md) for the boundary and [docs/compatibility.md](docs/compatibility.md) for what stays compatible.

## Contribution Gate

All issues and PRs from new contributors are auto-closed by default; see `CONTRIBUTING.md` templates and the `issue-gate` workflow. Maintainers review auto-closed issues daily and reopen worthwhile ones.

- `lgtmi` (maintainer reply): your future issues will not be auto-closed.
- `lgtm`: your future issues and PRs will not be auto-closed.

Keep issues short, concrete, and in your own voice. If you use an agent to draft a report, review and stand behind every line before submitting.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Scope Rules

- Keep Euler-specific changes confined to the Euler layer listed in `docs/upstream.md`. Do not refactor PI Core while rebranding; those are separate changes.
- PI-format resources (prompts, skills, extensions, themes, packages) must keep loading unchanged. Run the compatibility tests when touching loaders.
- Every user-visible surface and every network call is audited: `npm run check` runs `check-euler-branding.mjs` and `check-euler-network-policy.mjs`. Both must stay green.

## Before Submitting a PR

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.
