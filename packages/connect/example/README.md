# The example site: Sign in with Saltix, the session at the server

A whole site that signs its visitors in with Saltix in the **server-held mode** (Saltix 19-connect §15,
[docs/connect.md](../../../docs/connect.md#5-the-two-modes-the-pages-own-and-the-server-held)): `server.mjs` runs
`@saltix/connect/server` on Node's own `http` module, and `page/` is the page, the server's courier. Copy it into any
site or DApp that keeps accounts, a shop, an admin page — anything with a session.

```sh
SALTIX_GENESIS=<the network's genesis hash> SALTIX_RELAYS=/saltix/r/1/,/saltix/r/2/ npm run example:connect
```

- **The server** (`createServerConnect({ node, network, genesis, origin, name })`) makes the keys of every offer and
  keeps `Q`'s secret for 5 minutes; `POST /connect/offer` hands the page the public parts. `POST /connect/login`
  takes each payload the page's slot received, sealed as it came, and answers the server's word on it: the wallet's
  notice, its reply, a refusal with its reason, or the session opened — after every check (the offer live, the login
  this offer's and in time, the signature, the signer the account's by its key event log from `SALTIX_NODE`, the
  allow-list of `SITE_ALLOW` when there is one) with the offer spent in the same step. Then a cookie of the server's
  own (`site_session`: HttpOnly, SameSite=Lax, Secure on https), minted after the checks and derived from nothing the
  page sent. `GET /me` says who is signed in; `POST /signout` ends it.
- **The page** (`page/app.js`) is `createConnect({ network, relays, server: { offer, login } })` with the button and the
  dialog: it holds no secret, keeps nothing, forwards every payload, delivers the confirmation the server sealed so
  Saltix says *Connected*, and asks `/me`.
- **The relays and the node** are the site's own paths, as [docs/connect.md §3](../../../docs/connect.md#3-the-relay-and-the-node-paths-of-your-own-site)
  sets them up: a browser cannot pin a relay's certificate, so a proxy of the site passes a path to each relay;
  `SALTIX_NODE` is a node this server reads key event logs from (a node of your own, or a relay's gateway through the
  same pinned proxy).
- **What to keep when you copy it**: every check before the cookie (never a session on a signature alone, never on a
  grant a page opened); the offer spent once; the `Origin` check on every `POST`; the limits (16 KiB a body, 10 offers
  a minute a client); a journal of names and numbers, never an address. **Never a hosted check as the only way**: this
  server checks logins itself, against a node the site chooses; a login server of anyone else's would sign in whoever
  runs it, and stand in every site's critical path.

`packages/connect/test/example.test.mjs` runs its routes, and the whole flow against a node the test plays.
