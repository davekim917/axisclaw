# json-render 0.22.0 for agent cards

An agent's `send_card` carries a json-render spec. The host checks it with `@json-render/chat`'s `toCard`, against a
catalog built with `@json-render/core`'s `defineCatalog` (`src/channels/card-spec.ts`), and posts the resulting Chat SDK
card through the adapter. Neither package does I/O of its own. `@json-render/chat` imports `chat` for types only, and
`@json-render/core` depends only on `zod`, which resolves to the 4.6.5 the Chat SDK already loads. The lockfile adds the
two packages and nothing else.

0.22.0 is the first release of `@json-render/chat` and the latest of `@json-render/core`.

## @json-render/chat none → 0.22.0

Source: https://github.com/vercel-labs/json-render/tree/v0.22.0/packages/chat (README.md and src, read in full)

- `toCard` validates every element's props and the spec's structure and throws `CardSpecError` with one issue per problem; the host refuses the post and records the issues where the agent's tool reads them · test: src/delivery-cards.test.ts
- a valid spec becomes a Chat SDK card that Slack's own converter turns into native header, fields, chart, table and actions blocks · test: src/delivery-cards.test.ts
- `limits` rejects a spec past a platform's caps instead of letting the adapter degrade it; the host passes Slack's caps for Slack and Discord's field cap for Discord · test: src/channels/card-spec.test.ts
- a component missing from the catalog is an issue, so leaving `Button` out keeps click-back buttons off display cards · test: src/channels/chat-sdk-bridge.test.ts
- an empty Card is refused rather than posted blank · test: src/channels/chat-sdk-bridge.test.ts
- `$state`, `$item`, `$template`, `repeat` and `visible` resolve when the card is built, and expansion stops at 1,000 elements and rows · not covered: the host passes the agent's spec to `toCard` unchanged and adds no expression handling; upstream's `src/render.test.ts` covers resolution and the budget
- `streamCard` and `toPartialCard` post and edit a card while a model streams it · not covered: the host never calls them; a card arrives complete in one outbound row

## @json-render/core none → 0.22.0

Source: https://github.com/vercel-labs/json-render/tree/v0.22.0/packages/core (src/schema.ts, src/prompt.ts, src/props.ts, src/visibility.ts)

- `defineCatalog` with a schema's `promptTemplate` hands the template each component's props, formatted by `formatZodType`, which generates the agent's `send_card` description from the catalog the host validates against · test: src/channels/card-spec.test.ts
- the default `catalog.prompt()` teaches streamed JSONL patches, events and state actions · not covered: the host never uses the default prompt, because a tool call carries a complete spec
