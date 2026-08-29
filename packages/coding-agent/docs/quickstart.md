# Quickstart

This page gets you from install to a useful first euler session.

## Install

Euler is distributed as an npm package:

```bash
npm install -g --ignore-scripts euler-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Euler does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed euler. npm installs are removed with npm:

```bash
# npm install -g
npm uninstall -g euler-agent

# pnpm
pnpm remove -g euler-agent

# Yarn
yarn global remove euler-agent

# Bun
bun uninstall -g euler-agent
```

Uninstalling Euler leaves settings, credentials, sessions, and installed Euler packages in `~/.euler/agent/`.

Then start euler in the project directory you want it to work on:

```bash
cd /path/to/project
euler
```

## Authenticate

Euler can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start euler and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching euler:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
euler
```

You can also run `/login` and select an API-key provider to store the key in `~/.euler/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once euler starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, euler gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Euler runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give euler project instructions

Euler loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Euler loads:

- `~/.euler/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Euler loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart euler, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
euler @README.md "Summarize this"
euler @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model for the current session. Press Ctrl+S in the model picker to save the highlighted model as the startup default. Use `/thinking` to choose a thinking level for the current session, or Ctrl+S in that picker to save the startup default thinking level. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
euler -c                  # Continue most recent session
euler -r                  # Browse previous sessions
euler --name "my task"    # Set session display name at startup
euler --session <path|id> # Open a specific session
```

Inside euler, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
euler -p "Summarize this codebase"
cat README.md | euler -p "Summarize this text"
euler -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Euler](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Euler Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
