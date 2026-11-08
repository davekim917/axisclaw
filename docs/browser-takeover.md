# Browser takeover

An agent that hits a sign-in it cannot do (SSO, MFA, a CAPTCHA) asks an owner to sign in for it. The owner signs in to a
throwaway **sidecar** browser the agent cannot reach; only the resulting session state is handed to the agent. The
password never enters the agent's container, chat, or the host.

## Flow

1. The agent runs `ncl browser takeover --url <the app's page> --site <name>`; the app redirects through its SSO.
2. The host starts a sidecar from the agent container's image (no mounts, no secrets: its only env is the two browser-launch settings below, `--memory 1g`, `sleep` bounding its
   life to the link plus binding TTLs, so it removes itself even past a host restart), opens the URL in it, starts its
   agent-browser dashboard with `--allowed-origins $BROWSER_TAKEOVER_ORIGIN`, and DMs an owner or global admin
   (`notifyOperators`) a one-time link, `$BROWSER_TAKEOVER_ORIGIN/t/<token>`, valid 30 minutes.
3. Opening the link shows one button (a GET spends nothing, so link unfurlers and safe-link scanners cannot burn it).
   Pressing it POSTs, which sets an HttpOnly `__Host-` cookie binding that browser to the sidecar for 2 hours and
   redirects to the viewer page (`src/modules/browser-takeover/viewer.ts`). The sidecar runs at a phone-width viewport
   (430×900). The owner taps the live view to click, drags to scroll, and types in the page's text box, which brings
   up a phone keyboard; its edits are replayed as keystrokes into whatever field they tapped.
4. The owner replies in the agent's conversation. The agent runs `ncl browser finish`: the host saves the sidecar's
   session (`agent-browser state save`), keeping only cookies the browser would send to the `--url` host and that
   origin's storage, to `data/browser-state/<workgroup>/<site>.json`
   (0600) and removes the sidecar. The agent `state load`s `/workspace/browser-state/<site>.json`.

A new takeover from the same session replaces the open one. Links, bindings and sidecars are tracked in host memory: a
host restart ends them (the sidecar still exits on its own).

## An app whose session lives on an identity provider

An app that holds its token in the browser and re-mints it through its identity provider comes back signed out if only
its own host is kept. Prefer a service identity with that app's API. Where there is none, and an owner has approved
handing the session to one agent, list the provider's hosts in `groups/<folder>/container.json`:

```json
{ "browserSso": { "<site>": ["login.idp.example"] } }
```

The key is the `--site` name. For that site, `finish` also keeps the cookies the browser would send to each listed host
and that host's `https` origin storage, and files the result privately (see Security model). Other sites are unchanged.

- **It hands over the provider's sign-in, not one app.** Those cookies open every app behind that identity provider, for
  as long as the provider honours them. The list is scoped to a site name, and nothing enforces that the agent only
  uses them there. The DM and the takeover page say so before the owner signs in.
- **Only `container.json` can widen.** There is no flag, and the file is read-only to the agent. A site's hosts are
  fixed when the DM goes out, so an edit made during a takeover applies to the next one.
- **Hosts are exact names of at least three labels.** `login.idp.example` is accepted. A wildcard, a name like `co.uk`
  or `idp.example`, an IP address, or anything else that is not a lowercase host name refuses that site's takeover before
  anything starts. There is no public-suffix list, so a suffix of three labels or more passes this check. A host keeps
  cookies scoped to its parent domain too, because the browser sends those to it.
- **A listed provider cannot be taken over as an app.** A takeover is refused when its `--url` shares its last two
  labels with a host in another site's list, because a cookie scoped to that parent domain would reach it. Left alone,
  the session would land in the shared directory under whatever `--site` the agent named. A site with hosts of its own
  is exempt, since it files privately. The check reads only this group's `container.json`, so a sibling
  group with no entry is not covered, and it knows only listed hosts, so list every host the provider signs in on. With
  no suffix list, a host under `co.uk` makes the check reach all of `co.uk` for this group.
- **A running container needs a restart first.** The private directory is mounted at spawn, so a takeover from a
  container older than the entry is refused before an owner is asked to sign in.
- **To revoke:** remove the entry, delete `data/browser-state-private/<folder>/<site>.json`, and sign the session out at
  the identity provider. Deleting the file does not end the session.

What a saved login can carry, read from agent-browser 0.38.2 with a fake app and identity provider, separate browsers:
`state save` exports all cookies, session-only ones included, but web storage only for the origin of the open page. So
a provider's storage is kept only if the page sits there at `finish`, and an app's own storage only if the page sits on
the app. `state load` restores sessionStorage by opening the origin's root and writing the keys, so an app that redirects
on load loses it. What recovers such an app is the provider's cookie: with it alone, both a full redirect and a silent
iframe signed back in. No real identity provider has been tried. Re-minting happens in the agent's own browser, which
reports itself automated, unlike the sidecar (below), and a provider may treat that differently.

## Sign-in pages that detect automation

Google sign-in and reCAPTCHA refuse a browser that reports itself automated, so the sidecar's Chromium runs with
`--disable-blink-features=AutomationControlled` (no `navigator.webdriver`) and a plain Chrome user agent for the
image's Chromium version (no `HeadlessChrome`). That does not change the host's datacenter IP, which reCAPTCHA also
scores; a site that still refuses needs another route (a session handed over from the owner's own browser, or a
browser with a residential IP).

## Security model

- **The agent never touches the browser the owner types into.** Typing into the agent's own browser would expose the
  password to the agent's code (`eval` on the field, network capture), and an SSO password unlocks far more than one
  app.
- **Only the app's session leaves the sidecar, unless an operator listed more.** Signing in through SSO also leaves
  the identity provider's session in the sidecar, which would open every app behind that SSO; it is dropped at export.
  The one exception is a host listed in `browserSso` (below). Where the app and the identity provider share a domain
  (Google's own apps on `google.com`), the domain filter cannot separate them, so do not hand those over this way.
- **An agent's `--reason` is plain and labelled.** The DM prints it last as the agent's own unchecked note, so it cannot
  pass for the disclosure above it. Only letters, digits, spaces and `, ' ? ! -` survive, because the note goes through
  the secret scrubber and each channel's markdown converter, and neither keeps an enclosure intact. The page shows no
  reason, and of the request only the host, which cannot hold a space or markup.
- **The owner checks the host.** The agent picks `--url`; the DM names its host, and a lookalike host is a phishing
  attempt to refuse. The viewer shows the host the browser is on, above the page and outside its pixels, in full, so the
  check still holds after a redirect. It comes from the browser's address, which a page cannot set: not the title, and
  not the path. It reads `Address unknown` until the stream reports one and whenever the stream drops, and `http://` is
  shown so a plain-text sign-in stands out. It only informs: nothing warns on a host the DM did not name, and a page
  opened in a popup never reaches the viewer, so its host is not shown and it looks like a tap that did nothing. A host with anything but letters, digits, dots, hyphens and underscores (or an IPv6 address) is
  refused, because `new URL` keeps characters that would be read as markup in the DM.
- **A stalled host shows.** The viewer's stream runs through the host's event loop, so a host stall freezes frames and
  input together, and input already sent lands all at once when it resumes. The viewer asks the host for `/alive` every
  second. After two seconds without an answer it says the connection has stalled and ignores taps until the answer comes,
  so a repeated tap cannot land twice, and a slow network costs a moment rather than a lockout. Typing keeps its place in the queue, because a dropped character is worse than a late one. Taps in
  the first seconds of a stall are still queued, since a stall cannot be told from a slow network any sooner.
- **Separate origin.** The dashboard is container-served code that expects to own `/`. On the board's origin it
  could call the board API with the owner's cookie, so it gets its own hostname.
- **No exposed port.** The dashboard binds the sidecar's loopback. The host proxy (`127.0.0.1:$BROWSER_TAKEOVER_PORT`)
  reaches it over `docker exec` (`src/modules/browser-takeover/bridge.ts`), so no other container can.
- **Viewing and input only.** The proxy forwards exactly two requests to the sidecar's agent-browser dashboard: a GET
  of `/api/sessions` and the GET upgrade of `/api/session/<port>/stream`. Everything else the dashboard serves,
  including its UI and its POST routes (`/api/exec` runs arbitrary agent-browser commands), answers 404 or 405.
- **The dashboard token stays on the host.** The proxy presents it upstream as the dashboard's cookie, with the
  `Origin` the dashboard requires; the viewer's browser holds only the binding cookie.
- **Coupled to agent-browser's stream protocol.** agent-browser's own dashboard UI handles only mouse events and
  keys typed into a focused canvas, so a phone can neither tap nor type in it; the viewer speaks the stream's
  messages itself (`frame`, `status`, `input_mouse`, `input_keyboard`). An agent-browser bump can change them.
  `viewer.test.ts` pins `AGENT_BROWSER_VERSION`, so a bump fails until someone runs a takeover on a phone (the
  page streams, a tap clicks, typing lands in a field, a drag scrolls) and moves the pin.
- **The proxy checks which page is asking.** It presents the trusted origin upstream, so the dashboard's own origin
  check no longer tells pages apart; the proxy refuses a stream upgrade whose browser `Origin` is not
  `BROWSER_TAKEOVER_ORIGIN`, and a session-list fetch marked cross-origin. A sibling page under the same domain would
  otherwise carry the binding cookie into the live view.
- **A widened login is private to one agent.** It goes to `data/browser-state-private/<folder>/` (0700, the file
  0600), mounted read-only at `/workspace/browser-state-private` into that agent group alone, never the workgroup's
  directory. That keeps it from siblings, not from the agent that holds it.
- **Saved logins are credentials at rest.** `data/browser-state/<workgroup>/` (0700, outside git and outside the
  workgroup shared tree) is mounted read-write at `/workspace/browser-state` into every member of the workgroup.
  Anyone who can read a file there can act as whoever signed in until the site expires the session. Delete the file to
  stop handing it out; sign the session out at the site to kill it everywhere. Prefer a least-privilege account for
  the agent over an owner's own login.

## Setup

Takeover is refused while `NANOCLAW_EGRESS_LOCKDOWN=true`: the sidecar has no route through the gateway, and its first
request goes to a URL the agent chose.

1. `.env`: `BROWSER_TAKEOVER_ORIGIN=https://browser.example.com` (HTTPS, its own hostname; agent-browser refuses an
   HTTP or loopback origin) and, optionally, `BROWSER_TAKEOVER_PORT` (default `3001`). Unset origin = feature off.
2. Route that hostname to `http://localhost:$BROWSER_TAKEOVER_PORT` in the tunnel (cloudflared: an `ingress` entry
   plus `cloudflared tunnel route dns <tunnel> <hostname>`), then restart the host.
