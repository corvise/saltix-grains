# Sign in with Saltix: websites and DApps

A DEX, a shop or any DApp signs its users in with **Saltix Connect**, the same standard Saltix's mini-apps use (Saltix
[19-connect](protocol/connect.md) §2–§5, §11–§13). The page learns which
account its visitor holds, proven by that account's key on the visitor's phone. Nothing secret leaves the phone, and
connecting grants the page nothing: everything it then shows is public on the chain, and every action stays a
transaction the visitor signs in Saltix.

`@saltix/connect` (`packages/connect`) is the page's side: the session, the offer as a QR code and a link, the grant's
checks (the account's key event log included), the connection kept for 30 days, the **Sign in with Saltix** button and
its dialog. `@saltix/connect/server` is a server's side, for a site that keeps a session: the server makes the offer's
keys and takes the login, the page is its courier ([§5, the two modes](#5-the-two-modes-the-pages-own-and-the-server-held)).
The site's own profile is signed once, offline, with `grain connect-profile`. This package's check of a grant
(`verifyGrant`, `checkGrant`, `checkAccount`, and when the node is asked again) is the reference: Saltix's explorer
(`/explorer/me`), where it began, follows it rule for rule, and the server runs the very same check.

## The flow, end to end

1. **The site publishes its Connect profile** at `https://<origin>/.well-known/saltix-connect`: its own words about
   itself, signed by its operator's key (below).
2. **It shows the Sign in with Saltix button** (`signInButton`, `connect.css`).
3. **A tap opens a session** (`createConnect(…).offer()`): the page makes a slot at a relay and fresh keys, and shows the
   offer: on a computer a QR code in a dialog titled "Saltix Connect" ("Scan with Saltix to sign in"), on a phone the link
   `https://saltix.io/connect#saltix-connect:1:…` ("Open Saltix"), which opens Saltix. An offer nobody scanned is
   replaced after 2 minutes, at once when a grant for it is refused after them.
4. **Saltix shows its Connect sheet**: "Saltix Connect" on top, the site's host in large type and its origin in full,
   the profile it fetched from the origin (checked: signed by a key that speaks for the owner it names, and the
   profile of this origin) "in its own words", and what the site gets: the wallet's address, worded as "it can follow
   your activity on the blockchain: balances, transfers, names". Without a profile, or with one that fails, the sheet
   shows the origin and the name the offer gives, marked as the page's own words, and says the site published none.
   The page meanwhile shows "Continue in Saltix" (the wallet's `ConnectSeen`).
5. **The user continues**: the wallet signs a login naming this page's network, origin, slot and session key, names
   where the page confirms (a reply slot of its own, [§6](#6-connection-feedback-the-page-shows-and-confirms)) and
   delivers the grant to the slot, sealed to the page.
6. **The page checks the grant** (`verifyGrant`: `checkGrant`, `checkAccount`): this session's network, origin, slot and
   key, a time within 10 minutes of its clock, the signature (Ed25519 strictly, as the node verifies: no key or `R` of
   small order, `s` reduced, no torsion in `R`; or P-256 with a low `s`), and that the signer is the account's now, by
   the account's key event log from the page's node (`account_log`) replayed offline: a plain account's own key while
   it has no controller, else a current device of the account, never a guardian, never the old key of an account that
   upgraded. The node's status is read again for each grant: a node now on another network or chain refuses it
   (`network`), and one that names no account policy keeps no logs, so even an empty log from it leaves the grant
   unchecked. Then the page keeps `{account, address, grant}` in this origin's `localStorage` for 30 days or until the
   visitor disconnects, **shows the connection at once** (`connected`), and **confirms it to the wallet** through the
   reply slot before its own slot closes, so Saltix says "Connected" on the page's word ([§6](#6-connection-feedback-the-page-shows-and-confirms)).
   In the server-held mode ([§5](#5-the-two-modes-the-pages-own-and-the-server-held)) the site's server made the keys,
   does this check, opens its own session and seals the confirmation; the page forwards and renders.
7. **The page reads public data** through a node (`account_get`, `account_history`, `book_links`…) with that account
   first, and asks Saltix to sign every action ([19-connect §7](protocol/connect.md#7-actions)): the page never signs.

Anyone who saw the QR code could deliver a grant of their own account to the slot: the page always shows which account
it now shows. A grant the page opened proves the account to one page session, for display; a server's login is the
server-held mode ([below](#5-the-two-modes-the-pages-own-and-the-server-held)).

## 1. The site's profile

Write the texts as a mini-app writes its `connect.json` ([docs/agents/app.md](agents/app.md#the-connect-profile-connectjson)):
a tagline that says what the site is, what it does, highlights that are facts, and what it keeps about a user and for
how long. In English, and in Russian when you can:

```json
{
  "texts": {
    "en": {
      "tagline": "Swap SALT and WORK at the best price",
      "about": "Example DEX finds the best rate across the network's books. Every swap is a transaction you sign in Saltix.",
      "highlights": ["You sign every swap", "No deposit: your coins stay yours"],
      "privacy": "Keeps nothing about you. Your address is public on the blockchain; the page reads your balances from a node."
    }
  },
  "website": null,
  "support": "mailto:help@dex.example",
  "terms": "https://dex.example/terms"
}
```

Then sign it with the operator's key file (a plain account's key, owner-only; never on the site's server):

```sh
npx grain connect-profile --origin https://dex.example --name "Example DEX" --category finance --key site.key \
  --profile site-connect.json --out public/.well-known/saltix-connect
```

- `--origin` is the page's origin exactly as the browser serializes it (`location.origin`): `https://`, a lowercase host,
  a port only when it is not 443, no path and no trailing `/`. `--name` is 1–32 characters; `--category` is 0–9 or its
  name (`other`, `tools`, `finance`, `social`, `games`, `shopping`, `education`, `news`, `business`, `developer`).
- The owner is the key's account; `--owner <address>` names a managed account whose Ed25519 device key signs.
- Each run goes above the revision the site serves now (read at `/.well-known/saltix-connect` as a wallet reads it) and
  the file written before, or takes `--revision N`. Wallets keep a site's profile for a day and replace it only with a
  higher revision, so a revision that starts over at 1 would reach none of them: when the site cannot be read and no file
  of it is here, the command asks for `--revision N` instead. `--offline` (a machine without the network) reads only
  the file.
- Serve the file at `/.well-known/saltix-connect` as `application/json`, with no redirect (a wallet follows none), at most
  64 KiB. A wallet fetches it without cookies or a referrer and waits at most 5 seconds.
- `readSiteProfile(origin, { node, genesis, policy, network })` (in `@saltix/connect`) reads it as a wallet does,
  owner's key event log included (`network`, `node_status`'s, holds a support address to it): a status page or a test of
  the site can call it. In Node, the server SDK's `signProfile`, `profileToJson` and `checkSiteProfile` do the same work
  as the command.
- `support` is a link, a `mailto:` address or a username, as a mini-app's; from protocol version 9 also the operator's
  own Saltix address (`"version": 2`), which a wallet opens as a chat. A consent binds a mini-app, so a site's profile
  names no other address ([Support for your app](support.md)).

Two things then vouch for each other: the origin serves the profile, so the origin claims the account; the account's key
signs the origin, so the account claims the site.

## 2. The button and the dialog

```html
<link rel="stylesheet" href="/saltix/connect.css">
<div id="signin"></div> <span id="account"></span>
<script type="module">
  import { createConnect, signInButton, openConnectDialog } from "/saltix/saltix-connect.js";

  const connect = createConnect({
    network: "devnet",                       // Saltix's test network is of the devnet kind
    genesis: "<the network's genesis hash>", // the node must be on it
    relays: ["/saltix/r/1/", "/saltix/r/2/", "/saltix/r/3/"],
    node: "/saltix/rpc",
    name: "Example DEX",
  });
  const show = (c) => (document.querySelector("#account").textContent = c ? c.address : "");
  show(connect.connection);
  connect.on("connected", show);
  connect.on("disconnected", () => show(null));
  signInButton(document.querySelector("#signin"), {
    lang: document.documentElement.lang === "ru" ? "ru" : "en",
    theme: "light",                           // navy on a light page; "dark": white on a dark one
    onClick: () => openConnectDialog(connect, { lang: "en" }),
  });
</script>
```

- **The button's look is fixed** so that users recognise it everywhere: Saltix's mark at its left and "Sign in with
  Saltix" ("Войти через Saltix"), on Saltix's navy `#0B1220` with white text (`saltix-signin--navy`, for a light page)
  or white with navy text (`saltix-signin--white`, for a dark one), at least 44 px tall, its corners rounded by a
  quarter of its height. Make it taller with `--saltix-signin-height`; do not restyle it. Classes: `saltix-signin`,
  `saltix-signin--navy`, `saltix-signin--white`, `saltix-signin__mark`, `saltix-signin__label`.
- **A strict Content Security Policy** is fine: the button and the dialog are built with DOM calls and classes only (no
  inline style, no markup parsed, so Trusted Types too), and `connect.css` is a file. The page needs `connect-src`
  for its relay and node paths (`'self'` when they are on the site).
- **`openConnectDialog(connect, { lang, theme })`** shows the QR code titled "Saltix Connect" with "Scan with Saltix to
  sign in", and on a phone (a coarse pointer) the **Open Saltix** link (`offer.app`: an intent link on Android, the
  https link elsewhere — it opens Saltix without unloading the page, [§6](#6-connection-feedback-the-page-shows-and-confirms));
  it follows the session (the phone's notice, a refusal and why, a failure with Try again, New code) and resolves with
  the connection, or null when closed (the session is cancelled then).
- **Your own UI** instead: `const offer = await connect.offer()` gives `offer.text` (what the QR code holds),
  `offer.link` (the https link, for a message or another device), `offer.app` (what Open Saltix on this device points
  at: an intent link on Android, `offer.link` elsewhere), `offer.qr` (`size` and one SVG `path`, or `svg` as text) and `offer.expiresAt`; events
  `offer` (a new one), `seen`, `checking`, `connected` (the connection), `refused` (`{reason}`: `origin`, `time`,
  `not_a_device`, `network`…, or `unchecked` when the node could not check it: asked again after 1 and 3 seconds only
  while it was unreachable, too slow or busy — HTTP 429, 502, 503, 504 or its JSON-RPC -32603 — and never for an answer
  of another kind; `retryable` says which), `failed` (`no_relay`, `network`, `node`),
  `reconnecting`, `disconnected`. Call `connect.handOff()` when the visitor opens the link on this phone (the offer then
  stays), `connect.wake()` when the page is in front again, `connect.disconnect()` to forget the connection.
- Without a bundler, serve `dist/saltix-connect.js` (one self-contained module) and `dist/connect.css` from the package;
  with one, `import … from "@saltix/connect"` and `@saltix/connect/connect.css`.

## 3. The relay and the node: paths of your own site

**Relays use self-signed certificates, which apps pin** by the SHA-256 their relay records publish (Saltix
[09-relay §10.1](protocol/relays.md#relay-records-and-certificate-pinning)). A browser cannot pin a certificate, so a page
cannot open `wss://relay:30335/` itself. The site passes a WebSocket path of its own to one relay each, and its proxy
pins the relay's certificate: saltix.io does it for the explorer at `/explorer/r/1/`, `/r/2/`, `/r/3/`. A public
gateway with a certificate browsers trust may come later; until then every site brings its own path. With nginx:

```nginx
upstream saltix_relay_1 { server <relay host>:30335; }

# Saltix Connect's link slot (19-connect §2): the relay's client protocol (WebSocket) at its root only.
location = /saltix/r/1/ {
    proxy_pass https://saltix_relay_1/;
    # Pinned: the relay's own self-signed certificate, the one whose SHA-256 its relay record publishes, and the name
    # it was issued for.
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/nginx/saltix-relays/relay-1.crt;
    proxy_ssl_name <the name in relay-1.crt>;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

- Take the relays and their pins from the network's wallet interface (`relay_list`: each endpoint with its
  `cert_sha256`), fetch each certificate once (`openssl s_client -connect <host>:30335 </dev/null | openssl x509 >
  relay-1.crt`) and keep it only if `openssl x509 -in relay-1.crt -outform der | sha256sum` is the pin. Give the page two
  or three relays: it tries them in random order and takes the next when one fails.
- An exact location (`location =`) passes the WebSocket alone: neither the relay's wallet interface (`/rpc`) nor its
  files (`/_file`) are reachable through it.
- **The node**: the page asks `node_status` (the network, its genesis and its first account policy) and `account_log`
  (an account's key event log), plus whatever public data it shows. Pass a path to a node of your own
  (`location = /saltix/rpc { proxy_pass http://127.0.0.1:30334/; }`, a node's wallet interface listens on loopback),
  or to a relay's gateway (`POST /rpc` on its client port, [09-relay §10.7](protocol/relays.md#the-wallet-interface-at-a-relay)) through the same pinned proxy; and let
  through only the read-only methods the page calls, as the explorer's origin does.
- The page and its relay must be of one network: a relay whose hello names another network kind is refused, and so is
  a node of another network or genesis.

## 4. On a test network

- Saltix's test network is of the `devnet` kind (`dsalt` addresses). A release Saltix connects only to `https://`
  origins; a debug build also takes `http://localhost`, `127.0.0.1` and `[::1]`, any port.
- `createConnect` checks what it is given at once: an origin that is not one a browser serializes, a name of more than
  40 bytes or with control or format characters, a genesis that is not 64 hex digits.
- Telemetry (`telemetry: (event, meta) => …`) names events and numbers (`connect_open`, `connect_seen`,
  `connect_grant`, `connect_refused` with its reason), never a key, a slot, an account or an address.

## 5. The two modes: the page's own, and the server-held

Saltix Connect signs a visitor in two ways, with the same offer, the same sheet in Saltix and the same bytes (Saltix
19-connect §15: no format changed, the vectors hold, and every Saltix released signs into both):

| | The page's own mode (§2–§5) | The server-held mode (§15) |
|---|---|---|
| Who makes the keys | the page (`makeKeys`) | the site's server (`createServerConnect`), which keeps `Q`'s secret |
| Who opens and checks the login | the page (`verifyGrant`) | the server — the same `verifyGrant`, in §15.2's order |
| What the page holds | `Q`'s secret for the slot's life; the connection for 30 days (`localStorage`) | nothing secret, nothing kept: it forwards every payload sealed, as it came, and asks its server who is signed in |
| The session | the page's: `connect.connection` | the server's: a cookie or a token it mints after every check |
| What it is for | a page that shows the visitor's account and asks Saltix to sign every action: a DApp whose every action is a transaction | anything with a session: accounts, a shop, an admin page, a closed site, a DApp's back end, a mini-app's own website |
| The API | `createConnect({ node, name, … })` | `createConnect({ server: { offer, login } })` and `@saltix/connect/server` |

**In the page's own mode the grant is for display only.** It is a bearer artefact: whoever holds its bytes (any script
of the origin — it sits in `localStorage` —, a browser extension, any server or log the page sent it to, the other
end of a relayed QR code) holds all it proves, and it names the page's own session key and slot, not a challenge of
any server, so a server cannot tell the visitor from someone who copied it, within its 10 minutes or after them. So
**a server never takes a page's grant as a login**: never exchanges it for a session or a token, never lets it stand
for the visitor, never acts for the account because of it. `Connection.grant` is kept for the page to show which key
signed, nothing more.

**The server-held mode is a server's login**, built from the same pieces: the server gives the page a fresh `sid`,
the single-use nonce of the server's own, with `Q`'s and `P`'s public keys; the wallet signs a login naming the page's
origin, that `sid` and `P` with a key of the account; the server checks the signature and the account's key event log
itself, within the login's 10 minutes, and spends `sid` in the same step that opens the session. The page is a courier:

1. **The server** (`@saltix/connect/server`, Node 20 and later) makes and keeps the keys of each offer for 30
   minutes, bounded in number (10 000, the oldest dropped first):

   ```js
   import { createServerConnect } from "@saltix/connect/server";
   const connect = createServerConnect({
     node: "http://127.0.0.1:30334",      // a node of your own, or a relay's gateway through a pinned proxy (§3)
     network: "devnet", genesis: "<the network's genesis hash>",
     origin: "https://shop.example",       // the page's origin: the login is held to it
     name: "Example shop",
   });
   // POST /connect/offer  → answer JSON.stringify(await connect.offer())            {sid, boxKey, page, origin, name}
   // POST /connect/login  → const taken = await connect.take(body, admit);          body: {sid, payload} as the page sent them
   //                        if (taken.outcome === "connected") mint your session for taken.connection (a cookie: HttpOnly,
   //                        SameSite=Lax, Secure), then answer JSON.stringify(taken) — with your own fields beside, if any
   ```

   `take` answers the server's word on each payload, which the page is answered with as it is: `ignored` (it did not
   open or decode: anyone who saw the QR code can deliver to the slot), `seen` (the wallet's notice), `reply` (the
   wallet's reply, kept), `refused` with its reason (a grant's reasons — `origin`, `time`, `signature`,
   `not_a_device`… —, `offer` for an offer the server does not hold or holds no more, `spent` for one whose grant was
   taken, or the site's own from `admit`), `unchecked` (the node could not answer: not a refusal, and never a session),
   or `connected`: `connection` (the account's public facts: `network`, `account`, `address`, `signer`, `managed`,
   `since` — never the grant's bytes) and `confirm` (the confirmation sealed for the page to deliver, or null). The
   checks run in §15.2's order and stop at the first that fails; a refusal spends nothing, so the person the code was
   shown to may still sign in. `admit(connection)` is the site's own rule after the protocol's — an allow-list, a time
   window, a role — answering null or a reason; `confirm(sid)` seals the confirmation again for a server that answers in
   two steps; `drop(sid)` ends an offer early.

2. **The page** (`createConnect({ server })`) asks the server for the offer, opens the slot at a relay as any page
   does ([§3](#3-the-relay-and-the-node-paths-of-your-own-site)), shows the code, forwards every payload the slot
   receives to the server sealed, opens nothing, and renders what the server answered; the button and the dialog are
   the same:

   ```js
   const connect = createConnect({
     network: "devnet", relays: ["/saltix/r/1/", "/saltix/r/2/"],
     server: { offer: "/connect/offer", login: "/connect/login" },   // no node, no name: the offer is the server's
   });
   connect.on("connected", (c) => location.assign(c.answer?.next ?? "/"));   // the server's cookie is set by then
   ```

   `connected` carries the account's facts and, in `answer`, whatever the server answered beside (where to go, a
   name); `connect.connection` is null (the session is the server's: ask it, as the example's `/me`); `refused` says
   the server's reason, `unchecked` when the server could not be reached or could not check; `failed {reason:
   "server"}` when the server gave no offer, or one for another origin. A server with another transport brings a
   `Courier` of its own in place of the two paths.

3. **The confirmation** stays the page's duty: the server, which held the wallet's reply and `Q`, seals
   `ConnectConfirm` to the reply's key and hands the page the bytes with the session; the page delivers them on its
   own slot connection and closes the slot, so Saltix says **Connected** on the server's word, carried by the page.

**The reference server.** `packages/connect/example` ([its README](../packages/connect/example/README.md), `npm run
example:connect`) is a whole site on Node's own `http` module: the two routes, a session cookie minted after the
checks, `/me`, sign-out, an allow-list, the `Origin` check on every `POST`, the limits (a body of 16 KiB, 10 offers a
minute a client), a journal of names and numbers. Copy it.

**Never a hosted check as the only way.** A site that trusts a login server of someone else's is signed in by whoever
runs that server, and that server stands in every site's critical path. The check is a library any site runs, against
a node the site chooses; a hosted convenience may come later beside it, never instead of it.

**What a site must never do** (19-connect §15.5): take a page-held grant as a login; hand the page a secret (`Q`'s
secret, a reply's key, a session's token before the checks); open a session on less than every check (a signature
alone proves a key, not an account; a node of another network or genesis proves nothing; an unchecked grant is not a
refusal and not a login); reuse an offer, keep one past its life, or make one whose origin is not the page's own; keep
or log the login's bytes, the account or the address beyond what serving the person needs.

## 6. Connection feedback: the page shows and confirms

The owner's rule (2026-10-21, Saltix 19-connect [§14](protocol/connect.md#14-connection-feedback)): the reference
standard for every site, mini-app and developer. The standard client does the page's part, in both modes; a page built
on it has only to render what the client tells it.

**The checklist**, which `grain lint` cannot run for a site, so run it yourself:

1. **Render the connected state from `connected`**, in the same tab, the moment the event fires: who (the address,
   shortened, the full form on request), since when (`connection.since`), and a Disconnect that calls
   `connect.disconnect()`. No reload, no polling, no "go back and check". The code the page showed is gone with it:
   the client has closed the slot, and nothing on the page offers the consumed offer again. A page that still shows
   its QR code after `connected` is wrong, not slow.
2. **Show the kept connection at once** on load (`connect.connection`), and follow `connected` and `disconnected` from
   other tabs (the client raises them on the storage event).
3. **The link to Saltix must not unload the page** (`openConnectDialog` does it right; your own UI: an
   `<a href={offer.app}>` without `target`, never `offer.link` on a phone). `offer.app` is an **intent link** on
   Android (`intent:1:…#Intent;scheme=saltix-connect;package=io.saltix.app;S.browser_fallback_url=…;end`): the browser
   hands it to the installed Saltix as an external intent and overrides the URL's loading instead of navigating the
   tab, so the page, its socket and its slot stay; without Saltix it loads the fallback, the https link, which offers
   the app (and then there was nothing to deliver to anyway). Elsewhere `offer.app` is the https link: iOS Safari hands
   a universal link to the app without navigating, and a computer has no app to open. Two ways that are wrong, both
   seen on 2026-10-21: a **new tab** leaves the visitor on a page that still shows the offer, and a second tap delivers
   to a slot the page has closed; the **https link in the same tab** on Android Chrome navigates the tab — the page
   unloads, its slot dies (the relay saw the socket close, 1001 "going away", a second after the tap), and the wallet
   has nothing to deliver to.
4. **A page unloaded on the way comes back to its slot.** Should the browser unload the page anyway (a browser that
   navigates on the link, a tab discarded in the background) and load it again within the slot's life, the client
   opens the **same slot with the same keys** (kept in `sessionStorage`: the slot id, `Q`'s secret and `P`'s public
   key, never a private key of the page; in the server-held mode the public keys alone, the server having given the
   page no secret; forgotten once connected, on New code, or past 30 minutes), so the wallet's
   delivery, tried again every 2.5 s for 30 s, still lands: a relay **parks** a slot whose connection closed for the
   rest of its half hour, holds what the wallet delivers to it meanwhile, and hands it over the moment the page opens
   the slot again (09-relay §10.3 step 6a; the client takes what comes right after `link_opened`). While the page is
   hidden (a phone's browser behind Saltix has no network) the client dials nothing — each attempt would fail and
   count — and opens the slot the moment the page is in front again (`connect.wake()` on `visibilitychange`).
   `connect.offer()` on load resumes; `connect.renew()` is fresh. Telemetry `connect_resumed`,
   `connect_resume_failed {kind}`.
5. **The confirmation is the client's.** When the grant checks, the client sends the wallet's reply slot a
   `ConnectConfirm` sealed to the wallet's key (the reply the wallet delivered right before the grant names the slot,
   the key and the login; in the server-held mode the server seals it and the client delivers it), waits up to 5
   seconds for the relay's `link_delivered`, and closes its slot. Saltix shows
   "Connected" on that confirmation alone; without it (an older page, a refused grant, a frozen tab) it says, after 10
   seconds, that the login was sent and the page has not confirmed. Telemetry: `connect_reply` (the wallet named its
   slot), `connect_confirm` with `outcome` `delivered`, `not_delivered`, `no_answer`, `no_reply` (an older wallet),
   `other_login`, `no_link`.
6. **The relay path must pass `link_deliver` from the page** (09-relay §10.3 step 5: a connection holding a slot may
   deliver): a relay before 2026-10-21 refuses it (`not_registered`), the client logs `not_delivered`, and the wallet
   falls back to "login sent" — honest, and the page is still connected.
7. **Serve the profile exactly** at `/.well-known/saltix-connect` as `application/json`, or serve nothing there (404).
   A single-page site that answers its page for every path shows Saltix an HTML document, which is no profile; from
   this date a wallet reads any non-JSON answer as "no profile", but a JSON document that is not a profile that checks
   is shown as "did not check" with its reason, so never serve a placeholder.

## Numbers

| | |
|---|---|
| A login's time | within 10 minutes of the page's clock |
| A connection kept | 30 days, or until the visitor disconnects |
| An offer shown | 2 minutes unseen, then a new slot and new keys; the slot is kept open every minute, 30 minutes in all |
| An offer at a server (the server-held mode) | 30 minutes from its making, then dropped with its keys; one grant per offer (`sid` spent with it); 10 000 offers kept at most, the oldest dropped first |
| An offer's name | 1–40 bytes; its origin at most 128 bytes |
| A site's profile | at `/.well-known/saltix-connect`, at most 64 KiB, read within 5 seconds, kept a day by a wallet |
| The wallet's delivery | tried again every 2.5 seconds while the relay finds no slot, 30 seconds in all; the page's confirmation waited for 10 seconds after |
| The page's confirmation | sent when the grant checks; the relay's `link_delivered` waited for 5 seconds, then the slot closes |
| A profile's texts | tagline 1–80, about 0–600, highlights 0–4 of 1–60, privacy 0–300 characters; 1–8 languages, `en` among them; 8 192 bytes in all |
| A site's name and category | 1–32 characters; 0–9 |
