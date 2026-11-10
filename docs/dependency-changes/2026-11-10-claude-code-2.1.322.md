# Claude Code 2.1.322 and Agent SDK 0.3.322 for Fable 5.2

The container CLI moves so the fleet can run Claude Fable 5.2: 2.1.302 has no `claude-fable-5-2` in its model catalog,
and 2.1.321 adds it. The SDK moves in lockstep. Behaviour changes that reach the runner's headless SDK session
(`bypassPermissions`, settings sources project/user/local, plugins, the hooks it registers, fast mode when configured,
agent teams) each get a bullet; bug fixes to that session are grouped in the last bullet. Terminal UI, VS Code, desktop,
cloud-session, Claude Tag, Code Review, self-hosted runner, gateway, Bedrock/Vertex/Foundry and `/claude-api` skill
entries do not run in a container.

## docker:claude-code 2.1.302 → 2.1.322

Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.303 through 2.1.322)

- 2.1.321: adds Claude Fable 5.2 and makes it the CLI's own default Fable model; the fleet sets the word `fable` itself through `ANTHROPIC_DEFAULT_FABLE_MODEL` · test: src/claude-spawn-defaults.test.ts
- 2.1.321: saved Fable 5.1 model picks move to `fable` on Pro and Max plans · not covered: applies to the CLI's own saved `/model` pick; containers pin the model through the SDK and env, never a saved pick
- 2.1.317: a subagent on a different model from the main conversation runs at that model's saved effort or its default, not the session's effort · not covered: subagent effort is chosen inside the CLI; subagent rows record NULL effort (`attachTurnEffort`)
- 2.1.316: `CLAUDE_CODE_SUBAGENT_EFFORT` sets the subagent effort when nothing else names one · not covered: the fleet does not set it
- 2.1.311: model ids drop the `[1m]` suffix where it has no effect, and the suffix is still accepted; the fleet keeps sending `[1m]` ids · test: src/claude-spawn-defaults.test.ts
- 2.1.304: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` accepts `k`/`M` suffixes and warns on out-of-range values; the fleet sends a plain integer · test: src/claude-spawn-defaults.test.ts
- 2.1.317: the Read tool's "file unchanged since your last Read" stub is gone, so a repeat Read returns the content (more context per repeat read) · not covered: inside the CLI, no fleet setting changes it
- 2.1.318: the 2.1.288 fix that kept earlier thinking on resume of a 2.1.286-or-older conversation is removed · not covered: needs a resumed pre-2.1.286 transcript
- 2.1.319: a request failing with a 401 no longer refreshes the login on every retry · not covered: the runner's OAuth slot rotation handles 401s itself; no fake reproduces repeated 401 refreshes
- 2.1.321: background command notifications and TaskStop results show Claude only the start and end of a command string over 1,000 characters, so a long invocation's middle is not in context · not covered: CLI-side, the runner does not read these notifications
- 2.1.321: headless sessions reload mods in `.claude/skills` when their files change (`CLAUDE_CODE_PLUGIN_DIR_WATCH=0` turns it off) · not covered: the fleet does not set the variable; a mod edited mid-session loads without a respawn
- 2.1.321: mods Claude writes turn on without asking in bypass mode (2.1.302 does too), and an agent-written mod's hooks run above the runner's `PreToolUse` guards; the image's `/etc/claude-code/managed-settings.json` sets `allowManagedModsOnly` so such a mod does not load · test: container/agent-runner/src/providers/claude-managed-settings.test.ts
- 2.1.318: a non-interactive launch with a `~/.claude.json` that is not valid JSON now fails start-up with a restore hint (SDK 0.3.318 reports `config_file_invalid`) instead of replacing it with defaults · not covered: no fake corrupts the file; a corrupted `~/.claude.json` now stops the session at start-up instead of being reset
- 2.1.318: a background subagent moves a shell command to the background after 3 minutes · not covered: subagent scheduling inside the CLI
- 2.1.312: a subagent's `autoCompactWindow` now lowers `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (never raises it) · not covered: no group-local or plugin subagent def sets `autoCompactWindow` today
- 2.1.309: `sed -i` runs as an ordinary Bash command instead of a simulated file-edit preview · not covered: under `bypassPermissions` neither form prompts; no test runs `sed -i` through the real CLI
- 2.1.321: fast mode tries standard speed on the same model before switching models when fast serving is rate-limited or failing · not covered: applies only to a group with fast mode configured; needs a failing fast-serving endpoint
- 2.1.304: compaction re-sends the skill list afterwards, and a resumed session no longer re-sends the whole list on each plugin reload · not covered: context-size effect inside the CLI
- 2.1.321: `AskUserQuestion` in SDK sessions denies a host permission answer that sets `afkTimeoutMs` · not covered: the runner never sets that field
- 2.1.314 / 2.1.317 / 2.1.319 / 2.1.321: `claude -p` exits 1 with an error instead of 0 on startup failure, disk-full or NFS transcript loss, or a deferred tool call whose MCP server is missing on resume · not covered: no fake fills a disk or drops an MCP server mid-resume
- 2.1.307: HTTP MCP tool calls are no longer sent twice when the connection closes mid-call; only read-only or idempotent tools are retried · not covered: needs a remote MCP server that drops connections
- 2.1.307: `setModel()` waits up to 15 s for the API to confirm a model instead of 5 s · not covered: needs a slow model confirmation; the runner's live model change calls `setModel`
- 2.1.311: requests the API marks not to retry are no longer retried · not covered: needs an API response carrying the no-retry mark
- 2.1.310 / 2.1.314 / 2.1.317: lower memory in non-interactive compaction of large transcripts, in long turns with many subagents, and at startup with many plugin commands · not covered: resource use, no behaviour contract
- 2.1.319: PostToolUse hooks now run, with up to 10 s, on a tool call that finishes after a new message interrupts the turn; the runner's `postToolUseHook` then clears that call's in-flight row instead of leaving it until the next reset · test: container/agent-runner/src/providers/claude.toolInFlight.test.ts
- 2.1.314: hooks matching `Bash` now run on shell commands the Monitor tool starts, and may block or ask but not approve or rewrite them; Monitor is allowed in the runner, so its `Bash` PreToolUse guards (git maintenance, destructive-gate self-approval, Snowflake connector, git clone, Codex companion and email blocks) now refuse a Monitor command they would refuse in Bash, while the stdin-closing rewrite still applies to Bash only. 2.1.319 likewise holds Monitor's WebSocket watch to Bash deny and ask rules · not covered: no test drives Monitor through the real CLI; the guards themselves are tested on Bash input
- remaining 2.1.303–2.1.322 entries that reach the headless session are bug fixes with no contract the runner relies on: compaction recovery and thrash avoidance, transcript ordering and write safety, MCP reconnect and tool-list races, skill and agent reloads after directory changes or worktree entry, Bash shell handling (parallel working directories, aliases, SHELLOPTS, process clean-up, disk-full errors), Write/Edit/Read/PDF/Grep result fixes, background-agent report delivery, startup git status accuracy, TLS and stalled-response recovery, and malformed tool-call retries · not covered: each needs the failure it fixes reproduced inside the real CLI; the live-path test covers the session end to end (container/agent-runner/src/providers/claude-live-path.test.ts)
- the rest are terminal, IDE, cloud-session, plugin-CLI, permission-prompt, sandbox, auto-mode or third-party-provider changes · not covered: those surfaces do not reach the runner (it uses `bypassPermissions` with no sandbox or auto mode)

## @anthropic-ai/claude-agent-sdk 0.3.302 → 0.3.322

Source: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (0.3.303 through 0.3.322)

- 0.3.322: parity with Claude Code 2.1.322, which carries Fable 5.2 (the CLI entries above) · test: container/agent-runner/src/providers/claude-live-path.test.ts
- 0.3.321: every hook was dropped when one event in the `hooks` option was `undefined`; now only that event is · not covered: every event in the runner's `hooks` map is set, so the case never arose
- 0.3.321: `resume`/`continue` read `initialize` during boot, so hooks register before start-up work · not covered: start-up ordering inside the bundled CLI; the live-path test does not resume
- 0.3.321: queued subagent reports in auto mode share one model call, all but the last ending in an empty `result` with `num_turns: 0` · not covered: auto mode only; the runner runs `bypassPermissions`
- 0.3.319: MCP tasks can run in the background with `CLAUDE_AUTO_BACKGROUND_TASKS=1` · not covered: the fleet does not set it
- 0.3.319: `session_writes_lost` is sent only when the CLI exits 0 · not covered: the runner does not read that message
- 0.3.318: result messages carry an optional `credential_expires_at` · not covered: additive; the runner reads none of it
- 0.3.318: the interrupt response lists and cancels a message held behind a model change · not covered: needs an interrupt during a model change
- 0.3.317: hook matchers take `onFailure: "block"`; a failing hook callback adds a warning message to the stream · not covered: additive; the runner sets no `onFailure`
- 0.3.317: `FileReadOutput`'s `file_unchanged` variant is removed · not covered: the runner does not read Read tool results
- 0.3.314: a settings file left out of `settingSources` no longer supplies auto-mode rules or saved permission consents · not covered: auto mode only
- 0.3.311: `ModelUsage` splits `cacheCreationInputTokens` into 5m and 1h fields; background start-up work waits up to ~10 s for the first model request; minimum Node is 18.14.0 · not covered: additive fields the runner does not read; the runner runs on Bun
- 0.3.309: host-supplied `managedSettings` keep `disableAllHooks` and the hook allow lists; `extractFromBunfs()` extracts into a per-user temp dir · not covered: the runner passes no `managedSettings` and does not call `extractFromBunfs()`
- 0.3.305: servers set with `setMcpServers` are no longer replaced by a same-named server from user settings · not covered: the runner passes MCP servers at query start, not through `setMcpServers`
- 0.3.304 / 0.3.305: `startup()` timeout and SessionStart-hook timing fixes; `getContextUsage()` row ids · not covered: the runner calls neither `startup()` nor `getContextUsage()`
- 0.3.303–0.3.320 entries reading only "parity with Claude Code" add nothing beyond the CLI section above · not covered: see the CLI section
