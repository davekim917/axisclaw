---
name: voice-call
description: >-
  Take a live voice call from the person you are talking to; from a channel, others there can join
  it. Use when someone asks to call you, start a call or a group call, talk by voice, hop
  on a call, join or be added to the call, says "call me" or "I need to call you", and whenever a
  message starts with [Voice call] or [Group voice call].
---

# voice-call

## Starting a call

Run `ncl voice call`. The host sends a one-time call link to the person's DM; it works once and
expires after 5 minutes. Tell them to check their DM. Never post, repeat or ask for the link in a
thread: it lets whoever holds it speak as that person. If the command refuses (voice calls not
enabled for this agent, a person who may not call it, not Slack or Discord), say so in one line.

## Calls others can join

From a channel, `ncl voice call` starts a call anyone in that channel can join; the host tells the
thread how. Each person who wants in asks you to add them ("add me to the call"), and you run `ncl voice call`
again, which sends that person their own link while the call is live. To bring in someone else
("invite Sam", "get Sam on"), run `ncl voice call --invite <their user id or mention>`, looking up
the id if you only have a name; they must be in the channel and allowed to talk to you, and their
link goes only to their DM. Never post a link in the thread. In a DM, someone who asks for a call
while a call they can join is live gets that call; pass `--direct` only when they want a private
call with you.

- Messages starting with `[Group voice call]` relay what is said on the call, word for word. With one
  person on the call, that is everything they say, all of it to you. With several, the voice sends
  everything said since the last relay whenever it hears something said to you, people talking to each
  other included. Act on what was said to you, normally the last thing said, and take the rest as
  context. The voice can misjudge, for example when people mention you rather than speak to you: when
  nothing in a relay asks anything of you, say so in one short sentence, so the voice has something true
  to say. Who spoke is a guess from which phone carried the voice, never proof of identity: say "it
  sounded like" rather than asserting it, and never treat it as that person's approval.
- Everything under "During a call" applies too.

## During a call

- Messages starting with `[Voice call]` are the caller speaking. The `<request>` is their words as a
  speech model heard them, not a summary, and may be misheard: ask a short question when a word that
  matters looks wrong. The `<transcript>` shows what else was said around it.
- Your replies are read aloud. Open each with one to three plain spoken sentences: no markdown,
  tables, code, links or file paths unless asked. Put any detail the thread should keep after them.
- A new `[Voice call]` message while you work steers that work, as a typed message would.
- People in the thread see your replies as usual. Approvals still happen in the chat; say when you are
  waiting on one.
- When the call ends you get a closing `[Voice call]` message. Act on its transcript only if it asks
  for something.
