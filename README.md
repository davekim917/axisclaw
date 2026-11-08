# AxisClaw

An AI workforce you run yourself. AxisClaw is a fork of [NanoClaw](https://github.com/nanocoai/nanoclaw), customized for agents that do real work in production: one agent handling many conversations at once, or many agents with their own roles. Agents run in isolated containers with their own identity, instructions and tools, and work from Slack or Discord.

## Status

Early. AxisClaw is built and used daily by one operator, on one Linux host, and it is published as it is developed. It is not a packaged product yet:

- It is built on [NanoClaw](https://github.com/nanocoai/nanoclaw) and still uses NanoClaw's internal names: the `ncl` CLI, `nanoclaw.sh`, the `nanoclaw-v2-<slug>` service and the `nanoclaw-agent-v2-<slug>` container image.
- It runs on Linux. The setup scripts also carry NanoClaw's macOS path, which is not exercised here.
- Slack and Discord ship in this tree. Other channels install from NanoClaw's own `channels` branch and have not been tested against this code. To fetch that branch, setup adds a git remote named `upstream` pointing at NanoClaw's repository.
- Expect breaking changes. [CHANGELOG.md](CHANGELOG.md) records the ones that need an action from you.

## What it adds to NanoClaw

| Addition                       | What it does                                                                                                                                          | Doc                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Workgroups                     | Groups sibling agents around a shared pool: chat archive, durable memory, and inherited secrets, tools and MCP servers.                               | [docs/workgroups.md](docs/workgroups.md)                         |
| Cross-workgroup reads          | Grants one workgroup read-only access to another's data, by policy on the host.                                                                       | [docs/workgroup-read-access.md](docs/workgroup-read-access.md)   |
| Fleet-wide MCP servers         | Adds an MCP server to every agent with one command, as data rather than code.                                                                         | [docs/fleet-mcp-servers.md](docs/fleet-mcp-servers.md)           |
| Remote MCP over OAuth          | Connects a remote MCP server through its own OAuth flow, with no developer app and no pasted key, and keeps the token fresh.                          | [docs/mcp-oauth-integrations.md](docs/mcp-oauth-integrations.md) |
| Secret intake                  | An agent asks for an API key, and a person enters it in a Slack or Discord form that writes straight to the vault. The key never passes through chat. | [docs/secret-intake.md](docs/secret-intake.md)                   |
| Three providers, with fallback | Claude, Codex and OpenCode providers in the tree. A group can fall back to another provider when its account stops answering.                         | [docs/provider-fallback.md](docs/provider-fallback.md)           |
| Work that survives restarts    | `continue_work` lets an agent promise follow-up that a fresh container must account for after a kill.                                                 | [docs/agent-runner-details.md](docs/agent-runner-details.md)     |
| Keyed task dispatch            | Admits one-shot tasks under idempotent keys, so a repeated event never runs twice.                                                                    | [docs/keyed-task-dispatch.md](docs/keyed-task-dispatch.md)       |
| Slack and Discord in the tree  | Both adapters ship with the code, including hot-attaching a new Slack bot without a restart.                                                          | `src/channels/`                                                  |
| Observatory                    | A web dashboard over your agents: decisions, agents, threads and schedules.                                                                           | [dashboard/PRODUCT.md](dashboard/PRODUCT.md)                     |

## Quick start

Before setup, install two things it does not handle:

- **A C toolchain.** The `better-sqlite3` dependency compiles a native module during install. On Debian or Ubuntu, run `sudo apt-get install -y build-essential`; on macOS, `xcode-select --install`.
- **Docker with BuildKit and Compose, if Docker is already installed.** Setup installs Docker only when it is missing. Ubuntu's `docker.io` package ships without either plugin, so the agent image build fails (`--mount option requires BuildKit`) and so does OneCLI (`Docker Compose is not available`). Either install Docker from [get.docker.com](https://get.docker.com), or add `sudo apt-get install -y docker-buildx docker-compose-v2` on top of `docker.io`.

Clone this repository, then run setup from its root:

```bash
git clone https://github.com/davekim917/axisclaw.git
cd axisclaw
bash nanoclaw.sh
```

`nanoclaw.sh` takes a fresh machine to a named agent you can message. It installs Node, pnpm and Docker if they are missing, registers your Anthropic credential with OneCLI, builds the agent container, and pairs your first channel. Run it from a normal terminal, not from inside a Claude session.

## Learn more

- [CLAUDE.md](CLAUDE.md): how the system fits together. Written for coding agents, and useful for people.
- [docs/architecture.md](docs/architecture.md): the design of the message path, from a chat message to a container and back. It is a draft; where it disagrees with CLAUDE.md, CLAUDE.md is current.
- [docs/isolation-model.md](docs/isolation-model.md): what an agent can and cannot reach.

## Contributing

Issues and pull requests are welcome here. Development happens in a private repository, and this one is exported from it, so an accepted pull request is merged there and comes back here in the next export. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Credits

AxisClaw is built on [NanoClaw](https://github.com/nanocoai/nanoclaw) by nanoco, released under the MIT License. NanoClaw's copyright notice is kept in [LICENSE](LICENSE). This project is independent: it is not affiliated with or supported by nanoco, so please send issues about this code here, not to them.
