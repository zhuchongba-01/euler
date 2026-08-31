# Euler welcome panel

## Goal

Give a new Euler session a compact, branded terminal welcome panel inspired by the structure of Claude Code's startup screen, without copying its artwork or changing Euler's agent behavior.

## Scope

1. Show the panel only for a new, empty session. A resumed or continued session opens directly in its transcript.
2. At normal terminal widths, render a bordered two-column layout. At narrow widths, render the same content vertically.
3. The left side shows the Euler name and version, a welcome message, current model or login guidance, and current working directory.
4. The right side shows the three most recently modified Euler sessions, with a useful session label, relative time, and working directory. Session discovery starts after the first render so startup stays responsive.
5. Keep the existing footer model, context, token, and cost information unchanged.
6. Continue PI-compatible Skill discovery, including `~/.agents/skills`. Do not show the resource listing on normal startup; show it when `Ctrl+O` expands startup details or when the existing verbose mode is requested.
7. Do not display inherited PI changelog entries whose versions are newer than the current Euler version.

## Non-goals

- No change to Skill discovery, Skill content loading, extensions, tools, or provider behavior.
- No interactive dashboard or mouse-driven session picker in the welcome panel.
- No automatic version bump, npm publication, or GitHub release in this implementation step.

## Design

Use a dedicated TUI component rather than a static text header. The component owns responsive border rendering and receives the current model, working directory, and asynchronously discovered session summaries. While sessions are loading it displays a short loading message; an empty or unavailable result displays `No recent Euler activity`.

The existing startup expansion action becomes the resource-detail control for a new session: compact startup shows only the welcome panel, while `Ctrl+O` reveals the existing loaded-resource sections. Verbose startup retains the detailed behavior for diagnostics.

The changelog filter treats the installed Euler package version as an upper bound. This prevents a forked `0.1.x` package from treating PI's inherited `0.84.x` entries as updates.

## Acceptance criteria

- A new session shows the responsive Euler welcome panel and the last three sessions without delaying initial rendering.
- A resumed session has no welcome panel.
- Normal startup does not list Skill names; `Ctrl+O` or verbose startup reveals the resource list.
- The footer continues to show its existing model and usage data.
- Euler does not render inherited PI `0.84.x` release notes while its installed version is `0.1.x`.
- Unit tests cover narrow and wide panel rendering, recent-session formatting, normal versus resumed startup, resource visibility, and the changelog cutoff.
