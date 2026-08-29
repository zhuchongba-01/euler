# Euler Agent Harness

Euler is a terminal coding agent built as a downstream distribution of the [Pi agent harness](https://github.com/earendil-works/pi). It keeps PI's full Git history so upstream changes can be merged continuously (see [docs/upstream.md](docs/upstream.md)), while shipping its own branding, configuration, system prompt, privacy policy, and built-in web access.

* **Command**: `euler`
* **Config root**: `~/.euler/agent` (project-level: `.euler/`)
* **Telemetry**: none. Version checks are identify-free and fail silently.
* **Web access**: built-in, zero-config; the default auto route is anonymous Exa MCP with a DuckDuckGo HTTP fallback — paid providers are unreachable unless explicitly configured.

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts (NOOP in Euler) |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | The `euler` interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

Workspace packages keep their upstream `@earendil-works/*` names; only the CLI is published as Euler. See [docs/releasing.md](docs/releasing.md) for the naming decision still pending before the first release.

## Euler-specific documentation

* [docs/upstream.md](docs/upstream.md) — upstream sync rules and the Euler/upstream boundary
* [docs/compatibility.md](docs/compatibility.md) — PI resource compatibility and third-party extension diagnostics
* [docs/releasing.md](docs/releasing.md) — release flow, artifact naming, platform policy
* [docs/system-prompt-diff.md](docs/system-prompt-diff.md) — audited diff between the PI baseline prompt and the Euler prompt

## Permissions & Containerization

Euler inherits PI's permission model: no built-in sandbox for filesystem, process, network, or credential access. By default it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize it. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns (Gondolin extension, plain Docker, OpenShell).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, type check, and Euler audits (branding, network policy, prompt)
npm test              # Full test suite (skips LLM-dependent tests without API keys)
./euler-test.sh       # Run Euler from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "euler-${VERSION}-source.tar.gz"
cd "euler-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform windows-x64 --out "$PWD/out"
```

Windows x64 is the mandatory release target; other platforms publish only when their CI build and smoke test pass (see [docs/releasing.md](docs/releasing.md)).

## Supply-chain hardening

Same policy as upstream: npm dependency changes are treated as reviewed code changes.

- Direct external dependencies are pinned to exact versions; internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `EULER_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, the generated coding-agent shrinkwrap, and the Euler audits.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT. Euler depends on and distributes code from PI and `pi-web-access`; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.
