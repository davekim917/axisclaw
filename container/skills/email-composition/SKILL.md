---
name: email-composition
description: Write and send outbound email that reads like a person wrote it, not a bot. Use this whenever a real human will receive the words — client, customer, colleague, vendor, recruiter, support reply, cold intro — whether you send it yourself (`gws gmail +send`, Resend, a mail MCP) or hand a draft to the user to send. Use it even when the request never says "email": "send Dana the numbers", "let the vendor know we're pushing the date", "reply to that thread", "write back to her" all land here. Covers the HTML body shape, subject lines, the ceremony that makes email read as generated, splitting oversized attachments, and verifying the send actually landed.
---

# Email composition

Email is not Slack. The bullets, bold, and emoji that make a good Slack update
make an email look machine-written, because no colleague formats a note to you
that way. Send **HTML**, not plain text, and keep the HTML boring: a wrapper
`<div>` and `<p>` paragraphs, nothing else.

**This skill owns the envelope, not the prose.** The HTML wrapper, the subject
line, the greeting and sign-off convention, attachments, the send command, and
the verification are here. The words inside the `<p>` tags belong to
`humanizer`, which is a far better editor than any phrase list this file could
carry — it works 33 documented AI tells and hard-fails on em dashes. Draft the
body, run `humanizer` on it, then drop the result into the shape below. Do not
hand-roll a voice check in place of that step.

One idea does carry across both halves. **A human email carries information and
nothing else.** The giveaway is rarely word choice; it is the sentences that
convey nothing — the warm opener, the throat-clearing, the closing pleasantry
that repeats the closing pleasantry. Delete a sentence and ask what the
recipient lost. If the answer is nothing, it was ceremony. Spend the space you
free on something they needed: a date, a caveat, what happens next.

## The shape

Use this structure directly rather than composing your own. Mail clients strip
`<style>` blocks, classes, and external CSS, so an inline style on one wrapper
`<div>` is the only styling that survives every client — which is also why real
human mail looks like this.

```html
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">
<p>Hi Dana, Ray,</p>
<p>First paragraph says the thing. No preamble.</p>
<p>Second paragraph handles the one caveat worth knowing.</p>
<p>Happy to pull anything else you need.</p>
</div>
```

- **Every paragraph is a `<p>`.** Bare newlines collapse in mail clients.
- **Two to four paragraphs.** One idea each. If it needs five, it needs a call
  or an attachment.
- **Greeting**: `Hi <first names>,` — the names they actually go by (Dana, not
  Danielle, if that is how they sign). Skip `Dear`.
- **No sign-off block.** No "Best," no name, no title, no "— sent by an AI
  assistant." The account's own Gmail signature is the sign-off (see
  Signature, below), so yours would be a second one, and an agent signing with
  its own name is the loudest tell there is. Sign with a human's name only
  when that human asked you to send as them.
- **Allowed inside**: `<br>` within a paragraph, `<a href="https://…">text</a>`,
  and `<ul><li>` only when the content is genuinely a list of parallel items.
  That is it.
- **Keep it exactly this shape** and the approval card shows the email as the
  recipient reads it, with no command: the wrapper `<div>` with this style
  string unchanged; inside it only `<p>` paragraphs and `<ul>` lists; `<br>`
  and `<a href="https://…">plain text</a>` only inside a paragraph; list items
  plain text only; and `&amp; &lt; &gt; &quot; &#39;` as the only entities.
  Any other tag, attribute, entity (`&nbsp;`), style, or a link inside a list
  item puts the raw command on the card instead. So does text the approver's
  chat would restyle: `*`, `_`, backticks, brackets, `:emoji:` codes, or a
  line starting with `#` or a number and a period.
- **Leave out** `<table>` layouts, background colors, buttons, images, tracking
  pixels, web fonts, and headings. Every one of them is a marketing-template
  signal — recipients read them as bulk mail before they read a word. The dark
  mode consequence is concrete too: `color:#222` on no background inverts
  correctly, while a hardcoded background gives some clients black-on-black.

## Body: draft, then humanize

Your CLAUDE.md already requires `humanizer` on outbound prose. Treat it as the
drafting step, not a final polish: write the body, pass the **whole** body
through `humanizer`, and run it again after any substantive edit. A prior run
does not cover a new revision.

What `humanizer` cannot know is what belongs in an email at all. That part is
here:

- **Lead with the thing.** "Attached is the May baseline from Acme." No
  runway before it.
- **Caveats go inline as plain facts**, never in a `Note:` block. "The current
  forecast was too large to attach alongside it, so it follows in a second
  email."
- **Define units and terms once, tersely.** "Figures are units shipped, not net
  revenue."
- **One closing offer, or none.** "Happy to pull anything else you need." Two
  closers ("let me know if you have questions" stacked on an offer) is the
  single most common tell left after humanizing.
- **Never restate the recipient's question** back at them before answering it.
- **No bullets** unless the content is genuinely a list of parallel items. The
  Slack register does not transfer.

Resist re-editing after `humanizer` returns. Its output is the body; reaching
back in to "warm it up" is how the ceremony gets reintroduced.

### The same message, twice

Everything cut from the first version was ceremony. The second is shorter and
tells Sarah strictly more than the first did.

**Reads as generated:**

> Hi Sarah,
>
> I hope this email finds you well! I wanted to reach out regarding your
> request for the Q3 numbers. Per our conversation, please find attached the
> updated report. Please note that the September figures are preliminary at
> this time. Please don't hesitate to reach out if you have any questions.
>
> Best regards,
> Alex

**Reads as a person:**

> Hi Sarah,
>
> Q3 numbers attached. September is still preliminary. The month closes on the
> 14th and I'll send the final that afternoon.
>
> Happy to cut it a different way if that's more useful.

Four of the first version's five sentences carry no information. The one that
did ("September figures are preliminary") is buried behind "Please note that"
and left unresolved; the rewrite promotes it and answers the obvious follow-up
before Sarah has to ask it.

## Subject lines

Concrete and specific, sentence case, no `Re:` unless it is a real reply.
Number a split so the recipient knows what is coming.

```
Acme extracts (1 of 2): May baseline
Acme extracts (2 of 2): current forecast
```

Not: `Requested data`, `Following up`, `Your files`.

## Attachments

`gws` caps total attachments at **25 MB**. Check sizes before composing:

```bash
ls -lh /workspace/agent/send/
```

Over the cap, split into numbered emails and say so in the body — do not
silently drop a file or reach for a share link. A public link to client data is
a disclosure decision the human makes, not you; a named Drive share only works
if the recipient's domain is on Google.

Name files so they mean something a month later:
`Acme_May2026_Baseline.xlsx`, not `export_final.xlsx`.

## Sending

Outside scheduled tasks, sends are approval-gated — a human sees the
recipients, subject, body, and the command before it runs. Compose the whole
thing first, then run the send as **its own Bash command**: the `export`, the
`BODY`, and the `gws gmail` call, nothing else. A send that shares its command
with any other step (a `mkdir`, a draft file, a second command) is refused; do
those in a separate Bash call first. Values go in plainly: no globs, `~`,
`$'…'`, escapes or other variables.

Put the HTML in `BODY` with a quoted heredoc, so its quotes and apostrophes
survive, then pass it with `--html`:

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/<account>.json
BODY=$(cat <<'EOF'
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">
<p>Hi Dana, Ray,</p>
<p>…</p>
</div>
EOF
)
gws gmail +send --to "dana@example.com,ray@example.com" --cc "chris@example.com" --subject "Acme extracts (1 of 2): May baseline" --body "$BODY" --html -a /workspace/agent/send/Acme_May2026_Baseline.xlsx --format json 2>&1 | tail -8
```

Keep the `gws gmail` call on one line: a `\` line continuation is refused like
any other escape. The `export` line is required — without it `gws` reports
`auth_method: none` even with credentials mounted. Which account to send from is a group decision;
check the group's own instructions before assuming. `--html` takes fragment
tags only, no `<html>`/`<body>` wrapper. Add `--draft` when the human asked to
eyeball it in Gmail before it goes out — it saves instead of delivering.

### Signature

Gmail does not add the account's signature to mail sent through `gws`. When
the group's instructions say to include it, use the copy the host keeps for
the sending account at
`/workspace/.host/email-signatures/<account>.signature.html` (refreshed daily
from Gmail; the file is absent when the account has no signature). Read it in
its own Bash call first, then paste it into `BODY` exactly as it is, on the
line after the wrapper's closing `</div>`. Change nothing in it: the approval
card names the signature instead of showing it only when it matches that copy
byte for byte. Don't fetch the signature from Gmail yourself.

If this install uses a different mail tool (Resend, a mail MCP), everything
above still applies except the command — the body shape and voice are the skill.

## Verify

A success response is not evidence the mail went out with its attachments.
Check the Sent folder and confirm recipients, subject, and attachments:

```bash
gws gmail users messages list \
  --params '{"userId":"me","q":"in:sent subject:\"Acme extracts\"","maxResults":5}'
gws gmail users messages get \
  --params '{"userId":"me","id":"<ID>","format":"full"}' | grep -o '"filename":"[^"]*"'
```

Report what you verified, not what you assume. "Verified in the Sent folder:
attachments present at 19.7 MB and 24.6 MB, recipients and CC correct."

## Worked example

Two emails sent together, delivering data files to a client. Adapted from a
real pair that the recipient praised; only the client specifics are changed,
the wording and structure are not. The genre is narrow but the shape is not: a
scheduling note, a support reply, or a vendor chase uses the same wrapper, the
same two-to-four paragraphs, and the same delete test. Read these for the
register, not as a template for one email type.

**Subject:** `Acme extracts (1 of 2): May baseline`

> Hi Dana, Ray,
>
> Attached is the May baseline from Acme, pulled from production this
> morning. It is the May 2026 generation: January to April closed, May
> projected, June to December forecast. Approved 15 June.
>
> The current forecast was too large to attach alongside it, so it follows in a
> second email.
>
> Figures are units shipped, not net revenue.

**Subject:** `Acme extracts (2 of 2): current forecast`

> Hi Dana, Ray,
>
> Second of two. Attached is the current Acme forecast, the July 2026
> generation: January to June closed, July projected, August onward forecast.
>
> One difference to watch if you line the two files up. The baseline file is
> per distributor, while this one groups distributors into customers, so roll
> both to market level before comparing row counts.
>
> Figures are units shipped, not net revenue.
>
> Happy to pull anything else you need.
