# Contributing

Issues and pull requests are welcome here.

## How a contribution lands

AxisClaw is developed in a private repository, and this one is exported from it every night. A pull request here is not merged here directly:

1. You open a pull request on this repository.
2. The maintainer applies it to the private repository, where it goes through the same CI and review as any other change.
3. Once it merges there, the next nightly export brings it back here.

The pull request is closed when its change appears in an export, not through GitHub's merge button. Exported commits are authored as the project, so the pull request thread is where your contribution is credited.

## Before you start

- **Search first.** Check open issues and pull requests for related work.
- **One thing per pull request.** One fix, one skill, or one simplification.
- **Keep it general.** Code here runs for anyone who installs it. Settings for your own install belong in your own config, not in the source.

## What a pull request needs

- **Tests for what you touched.** Run the files you changed: `pnpm exec vitest run <files>`. The agent runner is a separate Bun package: `cd container/agent-runner && bun test <files>`.
- **Typechecks.** `pnpm exec tsc --noEmit`, plus `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` when you changed the runner.
- **Formatted code.** `pnpm install` installs a pre-commit hook that formats the TypeScript you stage under `src/`.
- **Invented names in fixtures and examples.** Never copy a real person, company, account, ID or domain into a test, comment or doc.
- **No breaking change without a migration path.** A change that needs an action from an existing install gets a `[BREAKING]` entry in [CHANGELOG.md](CHANGELOG.md) naming the skill to run or the doc that covers detect, why, fix, verify and rollback. When it moves a pinned external component, update [versions.json](versions.json) too.

## Skills

Most new capability ships as a skill rather than as core code. [docs/skills-model.md](docs/skills-model.md) explains the model, and [docs/skill-guidelines.md](docs/skill-guidelines.md) is the authoring checklist.

Channel and provider skills copy their adapter from the `channels` and `providers` branches of [NanoClaw](https://github.com/nanocoai/nanoclaw), which this project is built on. A new adapter belongs there, contributed to NanoClaw under its own guidelines. A fix to how this project installs or runs an adapter belongs here.

## Pull request description

Say what changes, why, how you tested it, and how someone uses it if it is a skill. A few clear sentences beat a long template.
