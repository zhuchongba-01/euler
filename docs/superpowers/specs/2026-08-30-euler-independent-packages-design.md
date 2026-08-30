# Euler Independent Package Release Design

## Goal

Publish Euler as an independent npm ecosystem without runtime dependencies on
upstream-branded packages.

## Package identity

The executable package is `euler-agent`. Every supporting public workspace
package uses the `@zhongchongba/euler-*` scope. The first Euler release is
`0.1.0`; all public Euler packages use that version together.

## Dependency graph

Source imports, workspace dependency ranges, generated shrinkwrap data, the
standalone installer lockfile, local release smoke tests, and build smoke-test
entries all use the Euler package names. No compatibility aliases are kept for
the old PI package names.

## Release process

The release script validates the public Euler package set, packs every package,
and publishes dependencies before the CLI package. The first release accepts
the already-set `0.1.0` version and checks that no target package version has
been published. Later releases continue using lockstep patch/minor releases.

GitHub Actions builds and validates the release first, then uses npm trusted
publishing to publish all Euler packages. The GitHub Release becomes public only
after npm publication succeeds.

## Verification

Run repository checks, validate every npm package with `npm pack --dry-run`,
build an offline local release, and run `euler --help` and `euler --version`
from outside the repository. The final release tag is `v0.1.0`.

## Licensing

Keep the repository MIT license and upstream attribution required by that
license. Rebranding changes package identity and user-facing metadata, not the
historical copyright notices.
