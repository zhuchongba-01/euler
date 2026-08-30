> euler can help you create euler packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Euler Packages

Euler packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `euler` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Euler Package](#creating-a-pi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Euler packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
euler install npm:@foo/bar@1.0.0
euler install git:github.com/user/repo@v1
euler install https://github.com/user/repo  # raw URLs work too
euler install /absolute/path/to/package
euler install ./relative/path/to/package

euler remove npm:@foo/bar
euler list                     # show installed packages from settings
euler update                   # update euler only
euler update --all             # update euler, update packages, and reconcile pinned git refs
euler update --extensions      # update packages and reconcile pinned git refs only
euler update --models          # refresh model catalogs only
euler update --self            # update euler only
euler update --self --force    # reinstall euler even if current
euler update npm:@foo/bar      # update one package
euler update --extension npm:@foo/bar
```

These commands manage euler packages and `euler update` can update the euler CLI installation. For experimental installer-managed installations, `euler update` installs the exact checked version into a staged, lockfile-backed release and activates it only after verification, leaving the current release intact if the update fails. Managed installations do not support `--force`; rerun the installer to repair one. To uninstall euler itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.euler/agent/settings.json`). Use `-l` to write to project settings (`.euler/settings.json`) instead. Project settings can be shared with your team, and euler installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
euler -e npm:@foo/bar
euler -e git:github.com/user/repo
```

## Package Sources

Euler accepts three source types in settings and `euler install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`euler update --extensions`, `euler update --all`).
- User installs go under `~/.euler/agent/npm/`.
- Project installs go under `.euler/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `euler update --extensions` and `euler update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `euler install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.euler/agent/git/<host>/<path>` (global) or `.euler/git/<host>/<path>` (project).
- When reconciliation changes the checkout, euler resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
euler install git:git@github.com:user/repo

# ssh:// protocol format
euler install ssh://git@github.com/user/repo

# With version ref
euler install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, euler loads resources using package rules.

## Creating a Euler Package

Add a `euler` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`. Positive manifest globs discover visible paths in lexical order. List dot-prefixed paths directly. If a glob would need to continue through a symlink, list the symlinked resource root directly.

### Gallery Metadata

The [package gallery](https://github.com/zhuchongba-01/euler) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `euler` manifest is present, euler auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When euler installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Euler bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@zhongchongba/euler-ai`, `@zhongchongba/euler-agent-core`, `euler-agent`, `@zhongchongba/euler-tui`, `typebox`.

Other euler packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Euler loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `euler config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `euler config` starts in global settings (`~/.euler/agent/settings.json`); press Tab to switch between global and project-local modes. Use `euler config -l` to start in project overrides (`.euler/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
