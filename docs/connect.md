# Sign in with Saltix: websites and DApps

A DEX, a shop or any DApp signs its users in with **Saltix Connect**, the same standard Saltix's mini-apps use (Saltix
[19-connect](protocol/connect.md) §2–§5, §11–§13). The page learns which
account its visitor holds, proven by that account's key on the visitor's phone. Nothing secret leaves the phone, and
connecting grants the page nothing: everything it then shows is public on the chain, and every action stays a
transaction the visitor signs in Saltix.

`@saltix/connect` (`packages/connect`) is the page's side: the session, the offer as a QR code and a link, the grant's
checks (the account's key event log included), the connection kept for 30 days, the **Sign in with Saltix** button and
its dialog. The site's own profile is signed once, offline, with `grain connect-profile`. This package's check of a grant
(`verifyGrant`, `checkGrant`, `checkAccount`, and when the node is asked again) is the reference: Saltix's explorer
(`/explorer/me`), where it began, follows it rule for rule.

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
5. **The user continues**: the wallet signs a login naming this page's network, origin, slot and session key, and
   delivers the grant to the slot, sealed to the page.
6. **The page checks the grant** (`verifyGrant`: `checkGrant`, `checkAccount`): this session's network, origin, slot and
   key, a time within 10 minutes of its clock, the signature (Ed25519 strictly, as the node verifies: no key or `R` of
   small order, `s` reduced, no torsion in `R`; or P-256 with a low `s`), and that the signer is the account's now, by
   the account's key event log from the page's node (`account_log`) replayed offline: a plain account's own key while
   it has no controller, else a current device of the account, never a guardian, never the old key of an account that
   upgraded. The node's status is read again for each grant: a node now on another network or chain refuses it
   (`network`), and one that names no account policy keeps no logs, so even an empty log from it leaves the grant
   unchecked. Then the page keeps `{account, address, grant}` in this origin's `localStorage` for 30 days or until the
   visitor disconnects.
7. **The page reads public data** through a node (`account_get`, `account_history`, `book_links`…) with that account
   first, and asks Saltix to sign every action ([19-connect §7](protocol/connect.md#7-actions)): the page never signs.

Anyone who saw the QR code could deliver a grant of their own account to the slot: the page always shows which account
it now shows. The grant proves the account to one page session, for display; it is never a server's login
([below](#5-a-grant-is-for-display-never-a-servers-login)).

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
- `readSiteProfile(origin, { node, genesis, policy })` (in `@saltix/connect`) reads it as a wallet does, owner's key
  event log included: a status page or a test of the site can call it. In Node, the server SDK's `signProfile`,
  `profileToJson` and `checkSiteProfile` do the same work as the command.

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
  sign in", and on a phone (a coarse pointer) the **Open Saltix** link; it follows the session (the phone's notice, a
  refusal and why, a failure with Try again, New code) and resolves with the connection, or null when closed (the
  session is cancelled then).
- **Your own UI** instead: `const offer = await connect.offer()` gives `offer.text` (what the QR code holds),
  `offer.link` (the phone's link), `offer.qr` (`size` and one SVG `path`, or `svg` as text) and `offer.expiresAt`; events
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

## 5. A grant is for display, never a server's login

The grant shows the page which account its visitor holds; that is all it is for. Use it to show the account and its
public data, and ask Saltix to sign every action ([19-connect §7](protocol/connect.md#7-actions)).

- **It is a bearer artefact.** Whoever holds its bytes holds everything it proves: any script of the origin (it sits in
  `localStorage`), a browser extension, any server or log the page sent it to, and the other end of a QR code someone
  relayed. It names the page's own session key and slot, not a challenge of any server, so a server cannot tell the
  visitor from someone who copied it, within its 10 minutes or after them.
- **So a server never takes it as a login**: never exchanges it for a session or a token, never lets it stand for the
  visitor, and never acts for the account because of it. A server that did would sign in whoever copied the grant.
  `Connection.grant` is kept for the page to show which key signed, nothing more.
- **A server's own login needs its own design**, which Saltix Connect does not have yet: the server gives a fresh
  random nonce, bound to its origin and spent once; the wallet signs that nonce with a key of the account; the server
  checks the signature and the account's key event log itself, within a short window, before it opens a session. A
  mini-app's server has exactly that already: `grain.signIn` and `SignIns` ([12-grains §5.1](protocol/grains.md#51-identity): a challenge the server gives
  and spends once). A website's server waits for the same in Connect's spec; until then it keeps no session by a grant.

## Numbers

| | |
|---|---|
| A login's time | within 10 minutes of the page's clock |
| A connection kept | 30 days, or until the visitor disconnects |
| An offer shown | 2 minutes unseen, then a new slot and new keys; the slot is kept open every minute, 30 minutes in all |
| An offer's name | 1–40 bytes; its origin at most 128 bytes |
| A site's profile | at `/.well-known/saltix-connect`, at most 64 KiB, read within 5 seconds, kept a day by a wallet |
| A profile's texts | tagline 1–80, about 0–600, highlights 0–4 of 1–60, privacy 0–300 characters; 1–8 languages, `en` among them; 8 192 bytes in all |
| A site's name and category | 1–32 characters; 0–9 |
