# Secret intake

Adding or rotating an API key without the key passing through chat, a session DB, a log or argv. The agent
(or the operator's shell) handles every part except the value itself; a person enters the value in a Slack or
Discord form.

```
ncl secrets intake --name <n> --host-pattern <api-host> [--header <h>] [--value-format '<fmt with {value}>']
                   [--path-pattern <p>] [--field '<name>[?]|<Label>[|<Header>[|<Format>]]' …]
                   [--compose basic|separate] [--groups <ids>] [--workgroups <ids>]
ncl secrets intake --name <n> --rotate [--field '<name>|<Label>' … --compose …] [--groups …] [--workgroups …]
ncl secrets intake-status --id <si-…>
ncl secrets grant --name <n> [--groups <ids>] [--workgroups <ids>]
```

## Flow

1. `intake` validates the name, the injection rule and the grant targets, checks the vault (a new name must
   not exist; a rotation must), and posts a card. An agent's request goes into the conversation and thread it
   was asked from; a host request, or an agent session with no conversation, goes to the first reachable owner
   or global admin DM (`pickOwnersFirst` → `pickApprovalDelivery`). The card states who asked, the host the key
   will be sent to, who gets it, and who may enter it. The call returns at once with an intake id.
2. The card's button (`ncs:<intakeId>`) opens a modal, private to whoever clicked it: others in the channel
   see the card, never the value. Opening refuses a clicker with no authority when the central DB lease answers
   within a second, and otherwise lets the click through; nothing waits past the platform's 3-second window.
   Slack goes through the Chat SDK's `openModal`. The Discord adapter has no modals, so the bridge answers the
   forwarded button interaction itself with a modal (`handleDiscordSecretIntake`), and answers the modal submit
   with a private (ephemeral) reply. Both skip the forwarded-event queue, which could otherwise hold them past
   the window. A Discord modal cannot mark a field invalid, so a refused submit says why privately and the
   person clicks the button again.
3. Submit validates each field (non-empty, no whitespace), claims the intake and closes the modal. Only then does the host
   check authority (below); a refused submit stores nothing, returns the intake to pending, and says why in
   the card's conversation. The vault write and grants follow: `POST /api/secrets` for a new secret, `PATCH` of the
   value for a rotation — through `src/onecli-secret-writer.ts`, which keeps the value out of argv. Any failure
   before the store completes marks the intake failed, on the card and to the requester.
4. The card is edited to the outcome, and the requesting agent session (if any) gets a host note: stored or
   not, and who it is granted to. The value never appears in either.

## Credentials in parts

With no `--field` the form has one field and the value is the secret. Declare 1–5 fields to ask for more;
each field is required unless its name ends in `?`. `--field` is repeatable (the `ncl` parsers keep every
occurrence of a flag declared `multiple`; any other flag given twice is refused rather than last-one-wins).

- `--compose basic`: exactly two required fields, stored as one secret, base64 of `<first>:<second>`
  (RFC 7617; the first may not contain a colon), `--value-format` default `Basic {value}`. For HTTP Basic and
  OAuth client credentials sent as `client_secret_basic`.
- `--compose separate` (the default for two or more fields): each field is its own secret `<name>-<field>`
  with its own header, `--field 'name|Label|Header[|Format]'` (format default `{value}`); `--header` and
  `--value-format` are refused. Headers must differ. A blank optional field stores nothing. Grants apply to
  every secret stored. If one write fails after another succeeded, the intake fails naming what was
  written; a group admin's partial store still sends the owner notice. On a create, the written secrets are
  ungranted: request each missing one as a single-field intake under its full name (`<name>-<field>`) and
  grant the rest with `ncl secrets grant`. On a rotation the written values are already live, so the pair
  may be mismatched until the missing field is rotated.

A rotation repeats the field names (and `--compose`) without headers, since the vault's values are
write-only and the form cannot tell their shape. Every named secret must exist. A separate rotation marks
every field optional and replaces only those filled in; a basic rotation needs both.

Only secret values go in the form. A part that is not secret (a user id, subdomain, account id) belongs in
chat or config. No step asks the user to encode or join anything themselves.

## Lane tokens (`--reserved-for`)

```
ncl secrets intake --reserved-for <approved-run-agent> --host-pattern <api-host> --path-pattern <exact path> [--header <h>] [--value-format '<fmt>']
ncl secrets intake --reserved-for <approved-run-agent> --host-pattern <api-host> --host-wide [--header <h>] [--value-format '<fmt>']
ncl secrets intake --reserved-for <approved-run-agent> --rotate
… [--compose basic --field '<id>|<Label>' --field '<secret>|<Label>']   # with any of the above
… [--entered-by <namespaced user id>]   # with any of the above
```

An approved-run lane's token is named `<agent> token`, and only that agent may be injected it (`src/reserved-secrets.ts`). `--reserved-for` is how one arrives through the form:

- **Host callers only.** `intake` is open to every caller, so this refusal is the boundary: an agent's request is refused whatever its `cli_scope`.
- The name comes from the agent, so `--name`, `--groups` and `--workgroups` are refused with it, and so are `--field` and `--compose`, except `--compose basic` with its two fields, for an API that takes HTTP Basic such as an OAuth client's token exchange: the two parts are joined into the one token, sent as `Basic {value}`.
- **A new token needs `--path-pattern` naming one exact path, with no `*`, unless the operator asks for `--host-wide` by name.** A lane key is usually member-wide on its platform, so the gateway path is a real second limit, and the exact path is the default.
- **`--host-wide`** stores no path rule. OneCLI reads that as `*`, so the gateway injects the token on every path of that one host, and the card and the form say so. It is for a lane that calls more than one path, whose token is used only by host code and never enters a sandbox: the lane's own allowlist is then the boundary, and nothing at the gateway backs it up. The Render lanes qualify: `render-request.ts` is the whole write policy, and reads go only to listed resources. It is refused without `--reserved-for`, with `--path-pattern`, and with `--rotate`.
- Only an owner or global admin can enter it, unless `--entered-by` names one more person; the form's one field is labelled with the agent.
- **`--entered-by <user>`** names the one other person who may enter it, for a key only they can make (on Render, only a workspace Admin can read production connection details). The user must be known to the host and be a scoped admin of an agent group of a target that runs as this agent, so the target entry goes in first; an owner or global admin is refused, since they can already enter it. The card goes to that user's own Slack or Discord DM and nowhere else: with no reachable DM, nothing is posted. They are admitted for that one intake, and only while still an admin of a group that qualified them; no role changes. Rotation works the same way.
- After the vault write, the host creates the OneCLI agent if it is missing (`ensureOnecliAgent`) and adds the one grant without removing anything the agent holds (`grantOnecliSecretToAgent`). It then checks that the agent, and no other, would be injected it (`tokenHeldOnlyBy`). Only then is the intake `stored`. Any failure on a new token removes it from the vault again, and the intake is `failed`.
- An exact path injects the token on that one path only, so a lane that calls several needs `--host-wide`: the Render env-var lane calls `/v1/users` and `/v1/services/<id>/env-vars/<key>`. The Snowflake lane polls `/api/v2/statements/<handle>` after a 202, but its documented scope is `/api/v2/statements*`, which this form can't store; a host-wide token would be wider than that scope.
- A new token is refused if its name reached the vault after the card was posted. If OneCLI kept a create whose answer was lost, the host finds it by name and removes it.
- `--rotate` replaces only the value; host and path stay as stored, so widening a token means deleting it and asking for a new one. It needs exactly one vault entry by that name, and runs the holder check before the write, so a stray holder never receives the new value, and again after. A check that fails after the write reports the new value stored and runs refused until the stray grant is fixed.

## Who may enter a secret

- An **owner or global admin**: any intake.
- The **user an approved-run lane token names with `--entered-by`**: that one intake, new or rotation (see above).
- An **admin of the requesting agent's group** (`user_roles` scoped admin): that agent's new secrets. Enable a
  user by granting them admin on the group. Plain group members cannot.
- **Rotation is owner or global admin only**, apart from a lane token's `--entered-by` user. A rotation changes the value every holder uses, and who holds a
  secret is decided by OneCLI agent grants, some made outside any `container.json` or workgroup declaration —
  so no declaration scan can prove a secret is the workgroup's alone.

Every store by a group admin sends an owner a DM, right after the vault write and before any other follow-up. A store
or rotation by an `--entered-by` user does too, once the lane token's attach and holder checks finish, or when they
end with the value possibly live. Each notice names who, which secret, the host and the grants — never the value. A failed notice is logged at error. A key
a group admin stores for their workgroup is used by every agent in it.

An agent's new-secret request goes into its own thread on Slack or Discord, the platforms that open the form.
A rotation, which only an owner can fill, goes into that thread only when the conversation is already judged
the owner's own: their DM with the agent, or a messaging group listed in the group's
`slack_user_token.also_allowed_in` (`isOwnerSafeSlackSession`, the same judgement that decides where the owner's
Slack token is injected). The host cannot tell which person's message led the agent to ask, so it relies on
that operator-curated judgement rather than guessing. Every other rotation, a host request, and any other
origin get the card in the first owner or global admin with a Slack DM. On Discord a finished card's edit also
clears its button (`clearActions`), since a Discord text edit otherwise keeps the components.

## What to check on the card

The **host pattern**: one exact host, no wildcards. The gateway injects the key into any request to that host,
so a wrong or hostile host gets the key. It is the one decision the form cannot make for you.

## Several hosts, one key

Some APIs take the same key on several hosts. A vault secret has one host, so `--host-pattern` repeats, up to
four times, and one pasted value is stored once per host as `<name>-1of<n>` … `<name>-<n>of<n>`. Each host is
listed on the card with the header it will be sent as. `host=format` gives that host its own value format, and
the others use `--value-format`. The set is stored whole or not at all: if a host's write fails, the secrets
already written are deleted. If the vault can't confirm what it kept, the intake reports an unknown state and
says to check by hand; it never claims that nothing was stored. The intake grants every member. `ncl secrets grant`
takes one vault name at a time, so granting a set later means naming each member.
`--rotate --name <name>` rotates the whole set with one value, and refuses unless every member from 1 to `n` is
in the vault exactly once. A partial set never gets a new value, because its hosts would then disagree. A rotation
that fails partway is reported as partly stored and names the members that already have the new value. A
member whose update got no answer is reported as unknown, since it may have changed. A
`--reserved-for` lane token keeps one host.

## A client-credentials pair

A client-credentials integration (`ncl integrations add-client`) needs a new client ID and secret when its key is
rotated, and the refresher has to read them back, which the vault can't do. So this card writes to the host store
instead:

```bash
ncl secrets intake --client-credentials <integration>
```

Only the host can ask for it, and only for an existing client-credentials integration; it takes no other flag. The
card goes to an owner's DM on a surface of the integration's own workgroup, and is refused if there is none. Only an
owner or global admin can fill it in. A token is minted from the new pair first,
so a pair the token endpoint refuses changes nothing and the integration keeps its current pair. Submit also refuses,
storing nothing, when the integration no longer has the host and group the card showed; post a new card then. A pair it accepts replaces the
old one in `data/mcp-oauth/<name>.json` (0600), and the new token reaches the vault straight away, with no restart.
If anything else goes wrong the outcome is reported as unknown; `ncl integrations list` shows where it landed.

## Grants

Grants are by name: a group's `container.json` `onecliSecrets` (`declareGroupSecret`,
`src/onecli-secret-grants.ts`) or a workgroup's `onecli_secrets` (`addWorkgroupOnecliSecret`). They are
written only after the vault write succeeds, because a declared name missing from the vault aborts every
spawn that inherits it. A new grant takes effect at the group's next container start; a rotation takes
effect on the next request.

An agent may grant only to its own group and its own workgroup. With no target, a new secret goes to its own
group and a rotation grants nothing new.
`grant` from an agent is held for admin approval (it changes who holds a credential without a form to
consent through); from the host it runs directly.

## Limits

- Pending intakes are in memory: a host restart drops them, and an old card's button answers "expired".
  Expiry is 24 hours. A new request for the same secret from the same session (or the host) replaces its own
  pending card; anyone else's pending request for it refuses the new one. Finished intakes stay visible to `intake-status` for an hour.
- Built and tested for Slack. Elsewhere it depends on the adapter's modal support; where there is none, the
  button says so.
- The value crosses Slack's servers as a form submission. It is never a message, so it is not in channel
  history, but Slack does handle it — weaker than a page served from this host, far stronger than chat.
- With `CHAT_SDK_DEBUG` set, a Slack adapter in webhook mode (no app token) logs raw request bodies, form
  submissions included. Socket mode does not. Leave it unset on a webhook-mode install.
- Website logins (a password typed into a web page) are out of scope; the gateway injects headers into API
  requests, not form fields.
