# json-render 0.22.0: a card keeps the props the host's catalog adds

The host extends json-render's standard catalog (`src/channels/card-spec.ts`) with a LinkButton `style`, a Table
`pageSize` and rich cells, and a Text `button`. `toChild` in `@json-render/chat` builds each element from a fixed list of
props, so the added ones were validated and then dropped before the card reached the adapter. The patch keeps every
parsed prop beyond the standard ones on Text, Table and LinkButton elements. Chat SDK's card types already carry a link
button's `style` and a table's `pageSize`, which Slack's converter renders; `button` and the table's rich cells are the
host's own, read only by `src/channels/card-spec.ts`.

The host now also imports `zod` itself, to declare those props. It names the 4.6.5 the lockfile already resolves for
json-render and the Chat SDK, so no package is added.

## @json-render/chat 0.22.0 → 0.22.0

Source: patches/@json-render__chat@0.22.0.patch (the only change; the release is unchanged)

- `toChild` keeps a non-null prop the catalog adds beyond the standard ones on a Text, Table or LinkButton element, so a LinkButton `style`, a Table `pageSize` and the host's Text `button` reach the card · test: src/channels/card-spec.test.ts
- an element built only from standard props is unchanged · test: src/channels/card-spec.test.ts
