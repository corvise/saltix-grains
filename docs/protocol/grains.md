# Grains: apps inside wallets

> Reflects Saltix 12-grains (approved 2026-10-05; bridge version 3, the page's frame, check-first sign-in, invoices
> from a registered server key and the Connect profile, 2026-10-16), as of corvise/saltix `7d3744c5` (2026-10-19).
> Section numbers are the specification's.

A **grain** is an app that opens inside a Saltix wallet, from the Apps section, a chat or a link, with the wallet's
identity, payments, storage and relays at hand and never its keys. Saltix calls grains *mini-apps* in what users read;
*grain* is the protocol's word. A grain may be a page, or a chat and nothing else ([app studio](app-studio.md)).

The SDK: `@saltix/grain` is the page's side of the bridge (§5), `@saltix/grain-server` the server's (manifests,
sign-ins, invoices, notifications, relays), and the `grain` command line makes, checks, signs, bundles and publishes
(§10). The vectors: `vectors/grains-v1.json`.

## 1. Forms

| Form | What runs | Who can change it |
|---|---|---|
| **Hosted** | pages from the HTTPS origins the manifest names | the owner, any time, on its server |
| **Sealed** | a bundle of files whose BLAKE3 hash the manifest names, served by the wallet itself (§8) | nobody: new code means a new manifest in the registry |
| **Chat** | no page: the grain is its chat, served by its server keys ([grain chats](grain-chats.md)) | its spec changes without a transaction ([grain chats §2](grain-chats.md#2-the-chat-spec)) |

Wallets show which form a grain is. A sealed grain can be audited once and trusted until its next version, works
offline, and reaches only the origins its manifest names. A hosted grain's server can change its code at any time, and
the wallet says so.

## 2. Manifest

```text
GrainManifest {
  slug:        String              3–32 of [a-z0-9-], starting with a letter or a digit; unique in the registry
  version:     u32                 at least 1, raised with every change
  owner:       [u8; 32]            the developer's account: it registers, updates and retires the grain; the deposit
                                   returns to it
  owner_key:   DeviceKey           signs the manifest and certifies server keys (§5.2): a key that speaks for `owner`
                                   (basics.md): its own Ed25519 key while it has no controller, otherwise one of its
                                   devices, a phone's P-256 key among them
  name:        Map<lang, String>   1–16 languages, "en" among them; at most 32 characters each
  description: Map<lang, String>   at most 16 languages; at most 200 characters each
  icon:        [u8; 32]            derive("Saltix grain icon v1", a 256×256 PNG), the PNG kept with the bundle or at
                                   origins[0]
  entry:       Entry
  permissions: u32                 a bit set of §6
  sponsor:     Option<[u8; 32]>    the account whose channel pays the grain's relay use (§5.4)
  min_host:    u16                 the lowest bridge version it needs (§5), at least 1
}
Entry = 0 Hosted { url: String, origins: Vec<String> }
      | 1 Sealed { bundle: [u8; 32], size: u64, sources: Vec<String>, start: String, connect: Vec<String> }
      | 2 Chat                    no page and no origin: the grain is its chat (app-studio.md §2)

manifest message m = derive("Saltix grain manifest v1", Borsh(manifest))
SignedGrainManifest { manifest, signature: [u8; 64] }    by owner_key over m: Ed25519, or P-256 as basics.md says
manifest id        = derive("Saltix grain manifest id v1", Borsh(manifest))
```

- **Languages.** A code is 2–8 of `[a-z-]`. Maps are encoded sorted by code. Texts are not empty and hold no control
  characters.
- **An origin** is `https://host[:port]`: a lowercase host of `[a-z0-9.-]` (at most 253 bytes, not starting or ending
  with `.` or `-`), a port of 1–65535 if any, and nothing after it.
- **Hosted**: 1–4 origins; `url` (https, at most 2 048 bytes) is at one of them.
- **Sealed**: `size` from 1 byte to 20 MiB; `bundle` is §8's hash; 1–8 https `sources` of at most 2 048 bytes each;
  `start` is a path inside the bundle of at most 256 bytes (`[A-Za-z0-9._/-]`, no leading `/`, no empty, `.` or `..`
  part); at most 8 `connect` origins.
- **Chat**: nothing to host. `permissions` holds at most `notifications` (4): no page asks for anything else. Its chat
  is served from the server keys its registry record names (§3).
- `permissions` holds only §6's bits.
- A manifest travels inside a transaction (at most 16 384 bytes), so a registered one has a Borsh form of about
  16 000 bytes at most; `grain lint` says so.

**The JSON form** is what a hosted grain serves at `https://<origin>/.well-known/saltix-grain` (and a sealed one in
its sources), and what `grain_get` gives in a registry record's `manifest` field:

```json
{
  "manifest": {
    "slug": "chess", "version": 3,
    "owner": "<hex, 32 bytes>", "owner_key": { "ed25519": "<hex>" },
    "name": { "en": "Chess", "ru": "Шахматы" }, "description": { "en": "Play a friend" },
    "icon": "<hex, 32 bytes>",
    "entry": { "hosted": { "url": "https://chess.example/", "origins": ["https://chess.example"] } },
    "permissions": 3, "sponsor": null, "min_host": 1
  },
  "signature": "<hex, 64 bytes>"
}
```

Fields by name, bytes in lowercase hex, `owner_key` as `{"ed25519": …}` or `{"p256": …}`, `entry` as `{"hosted":
{"url", "origins"}}`, `{"sealed": {"bundle", "size", "sources", "start", "connect"}}` or `{"chat": {}}` (an empty object,
nothing else), `sponsor` hex or `null`. The signature covers the Borsh form, so a reader rebuilds it from the JSON and
checks; the order of JSON keys does not matter. The SDK: `signManifest`, `verifyManifest`, `encodeManifest`,
`manifestId`, `iconHash`, `manifestProblem` (`grain sign`, `grain lint`).

## 3. Registry

The chain's registry keeps every grain by slug. Its calls go in a transaction's `Registry { call, amount }` action
([basics](basics.md#transactions-an-apps-tools-sign)); a call that breaks a rule fails and its value comes back.

| Call | Tag | Value | Effect |
|---|---|---|---|
| `RegisterGrain { manifest: SignedGrainManifest }` | 7 | the slug's deposit | the slug becomes the owner's; the registry keeps the signed manifest |
| `UpdateGrain { manifest }` | 8 | 0 | a newer version of a registered grain by the same owner |
| `RetireGrain { slug }` | 9 | 0 | the slug is closed for good; the deposit returns 30 days later |
| `ConfigureGrain { slug, servers: Vec<[u8; 32]>, category: u8 }` | 34 | 0 | the grain's server keys and category ([app studio §2](app-studio.md#2-the-registry)); protocol version 1 only |
| `BindHandle { handle, slug: Option<String> }` | 35 | 0 | a username the owner holds opens the grain's chat ([app studio §2](app-studio.md#2-the-registry)) |
| `SetGrainAccess { slug, public: bool, members: Vec<([u8; 32], u8)> }` | 36 | 0 | public or private, and the members with their roles ([app studio §2a](app-studio.md#2a-access-private-or-public-and-members)) |
| `RateGrain { slug, score: u8, review: String }` | 37 | 0 | any account but the owner rates the grain, or withdraws its rating ([app studio §6a](app-studio.md#6a-statistics-and-ratings)) |
| `SetGrainProfile { slug, profile: Option<SignedConnectProfile> }` | 38 | 0 | the grain's Connect profile, or `None` to clear it ([connect §11](connect.md#11-the-connect-profile)) |
| `ConfigureGrain { slug, servers: Vec<ServerKeyProof>, category: u8 }` | 39 | 0 | the same as 34, each key proving its holder named it; from protocol version 2 |

- **Who calls.** A grain's own calls (register, update, retire, configure, access, profile) only its owner: the
  transaction's sender is the manifest's `owner`, and `owner_key` speaks for the sender when the call is taken (and
  again when a managed owner's pending call takes effect). `RateGrain` is any account's but the owner's, `BindHandle`
  the handle's holder's. A node refuses a grain call that breaks a rule it can check alone (the slug, the bounds, the
  manifest's signature, the profile's slug, owner and signature) before it enters a block.
- **A managed owner's calls wait** for the account's delay, unless a quorum signs ([basics](basics.md#accounts-whose-keys-change)):
  a stolen phone cannot replace or retire a grain before its owner cancels. `RateGrain` does not wait.
- **Register.** The slug was never registered, retired ones included. The value is at least the slug's deposit:
  **100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more**. The registry keeps up to 100 SALT as the deposit and
  returns anything above at once; a wallet sends the deposit exactly, as `grain_get` quotes it.
- **Update.** The slug is registered, not retired, and the caller's; the new manifest has the same `owner` and a higher
  `version`. Its `owner_key` may be another key that speaks for the owner (a managed owner's new phone).
- **Retire.** The caller owns the slug and it is live. The registry keeps the slug, its owner, the last version and its
  manifest id, drops the manifest, the server keys and the profile, clears usernames pointing at the grain, and returns
  the deposit about 30 days later (`GRAIN_RELEASE`; `grain_get`'s `returns` says from when). The slug is never
  reused.
- **Configure, access, profile, rate**: their rules are on the pages each links to.
- **What the registry keeps** per slug: the owner, the signed manifest and its id, the version, the slots of
  registration, last update and retirement, the deposit, the server keys, the category, public or private and the
  members, the ratings' sums, the Connect profile and the highest profile revision it took. Nodes serve it with
  `grain_get`, `grain_list`, `grain_ratings` and `grain_history` ([wallet interface](wallet-interface.md#methods)).

The deposit makes squatting and spam cost something and comes back, so honest developers pay nothing in the end. The
registry judges no content: what a wallet lists, features or refuses is the wallet's policy (§9). A grain may also
open **unlisted**, from a link to its manifest (§4). A listed grain's manifest is the one in the registry: a wallet
opens it from there, not from the grain's origin.

## 4. Opening

- `salt:grain/<slug>` and `salt:grain/<slug>?start=<param>`; the same as `https://saltix.io/g/<slug>` for people
  without the app; a QR code of either; a link card in a chat; the Apps section (§9).
- `salt:grain/<slug>?chat` adds the grain's chat ([grain chats §6](grain-chats.md#6-adding-an-app)), and
  `salt:grain/<slug>?invite=<…>` is an invite to join the app ([app studio §2a.1](app-studio.md#2a1-invites)), not an
  opening.
- **Unlisted**: `salt:grain?manifest=<the URL of its JSON form, percent-encoded>` (and `&start=`). The wallet fetches it,
  checks it and says the grain is unlisted before opening it. `grain dev` prints such a link; `walletLink()` makes one.

`start` (at most 64 characters of `[A-Za-z0-9_-]`) reaches the grain as `grain_info.start`: a referral, a game's room,
an order.

## 5. The bridge

A grain talks to the wallet through `window.saltix.request({method, params})`, with `grain_*` methods. `@saltix/grain`
wraps it with types and events. The bridge version is `grain_info.bridge`:

- **1**: everything below not marked otherwise;
- **2**: adds `grain_chat_open {cert?, spec?}` ([grain chats §5](grain-chats.md#5-in-the-wallet));
- **3** (2026-10-16): adds `grain_manage_open` (Saltix 0.1.53), the page's frame (`safe_area`, `controls`, the
  `insets` event and the CSS variables, below) and `grain_login`'s `member` (§5.1a), which a page detects by the field
  itself (both Saltix 0.1.54).

A grain detects a method by the version and keeps working without it; `min_host` (§2) is only for a grain that cannot.

**Transport.** `window.saltix` has `isSaltix`, `isGrain: true`, `bridge` (the version), `request({method, params})`,
which resolves with the answer or rejects with `{code, message}`, and `on`/`off` for events. The wallet answers only
the main frame of an origin the manifest names (a sealed grain's virtual origin, §8). Requests are typed methods with
checked parameters: nothing a grain sends is executed. Every method has a rate limit; an answer or an event is at most
64 KiB of JSON per message (Saltix for Android from 0.1.55 sends a longer one in parts that its provider joins before
the page reads it; older wallets answer `5000` and drop a longer event). Bytes travel as lowercase hex.

**Codes.** `4001` the user refused (a switch the user left off on the Connect sheet included, when the page asks for
it again without a tap); `4100` not permitted (the manifest does not ask for it, no consent, no tap before a payment or
before leaving the grain, or not on the app's team); `4200` unsupported method; `4290` rate limited; `-32602` invalid
parameters; `5000` the wallet failed. (`@saltix/grain` adds `4900`: not in a wallet.)

| Method | Consent | Returns |
|---|---|---|
| `grain_info` | — | `{slug, version, form ("hosted"/"sealed"), listing ("verified"/"listed"/"unlisted"), host, host_version, bridge, language, theme ("dark"/"light"), safe_area {top, bottom, left, right}, controls {top, right, width, height} or null, network, start}` |
| `grain_ready`, `grain_close`, `grain_expand`, `grain_setHeader {color}` | — | — |
| `grain_haptic {kind}`, `grain_copy {text}` | — | — |
| `grain_share {text, url?}` | the system share sheet | — |
| `grain_openLink {url}` | — | opens it outside the grain (the wallet's browser or the system's) |
| `grain_scanQr {hint?}` | the native scanner, each time | `{text}` |
| `grain_login {challenge}` (hex, at most 64 bytes) | the Connect sheet, once per grain (§5.1) | `{key, signature, at, origin, member}` |
| `grain_requestAddress` | the `address` permission; once, revocable | `{address}` |
| `grain_pickContact` | each time | `{address}` of a contact the user picked |
| `grain_pay {invoice}` (hex of a `SignedInvoice`) or `{to, asset, amount, memo?}` (`amount` a decimal string in whole units, `memo` public) | each time, unless quick pay (§5.2) | `{id, status?}`: the transaction id; `status` `unknown` (submitted, outcome not known) or `already_sent` (the same payment was on its way) |
| `grain_storage_get {key}`, `grain_storage_set {key, value}`, `grain_storage_remove {key}`, `grain_storage_keys` | the `storage` permission | `{value}` (or `null`), `{keys}` (§5.3) |
| `grain_relay_open {grant?}` | the `relay` permission | `{address}` of the grain alias (§5.4) |
| `grain_relay_send {to, payload, keep?}`, `grain_relay_close` | the `relay` permission | — (§5.4) |
| `grain_notifications_allow` | the `notifications` permission; once, revocable | `{allowed}` (§5.5) |
| `grain_chat_open {cert?, spec?}` (version 2) | a tap of the user | — : opens the grain's chat |
| `grain_manage_open {section?}` (version 3; `section`: `"members"`) | a tap of the user; the user on the app's team | — : opens the grain's own manage page |

- **A tap first.** `grain_pay`, `grain_chat_open`, `grain_manage_open`, and asking again for what the user switched off
  on the Connect sheet (`grain_requestAddress`, `grain_notifications_allow`), work only within 5 seconds of the user's
  tap on the grain, which the wallet records itself: the page's word, or a script calling the bridge, does not count.
- **The app's own page** (`grain_manage_open`). Only the owner's wallet signs what changes the registry record (members,
  access, server keys, manifest), so a page cannot; it can take its team there. The wallet opens the manage page of the
  grain itself (no parameter names another), at `section`, above the grain; Back returns to it. It does so only when
  the registry, read then, lists the user as the owner or a member with the developer or viewer role: anyone else, or
  a request while the registry cannot be read, gets `4100` or `5000` and nothing opens; an unknown `section` is
  `-32602`; a wallet without it answers `4200`.
- **Events** (`saltix.on(event, handler)`): `theme {theme}` and `visibility {visible}`; `insets {safe_area, controls}`
  (version 3); `relay {from, payload}` once the page opened the relay (§5.4). `back` and `payment` are reserved for
  later.

**The page's frame: insets and the wallet's controls (version 3).** A wallet lays a page out inside the safe area by
default, or edge to edge when the page declares `viewport-fit=cover` (§7). It tells the page, in CSS pixels, from the
edges of the page's own viewport:

- `safe_area {top, bottom, left, right}`: how far the system's UI reaches into the page (the status bar, a display
  cutout, the navigation bar or gesture area, the screen's rounded corners). Inside the safe area all four are 0.
  Edge to edge they are the real reach, except at the bottom while a keyboard is open: the page ends above the
  keyboard, and `bottom` counts only what reaches beyond it. The page keeps its text and controls inside them.
- `controls {top, right, width, height}`: the wallet's controls while they float over the page, `top` from the page's
  top edge and `right` from its right edge; `null` while they do not (inside the safe area they sit in the wallet's
  band above the page). The page keeps every tappable element out of that box, and its own top bar clear of it: a
  title stops `right + width` short of the right edge, or the bar starts below `top + height`.
- `insets {safe_area, controls}` comes whenever either changes: the phone turned, unfolded or folded, the window
  resized, a keyboard opened or closed, or the frame changed from one way to the other.
- **CSS variables, with no script.** The wallet sets the same values on the page's `:root` from the document's start
  and keeps them current: `--saltix-safe-top`, `--saltix-safe-right`, `--saltix-safe-bottom`, `--saltix-safe-left`
  (`safe_area`), `--saltix-controls-top`, `--saltix-controls-right`, `--saltix-controls-width`,
  `--saltix-controls-height` (`controls`; `0px` each while it is `null`), each a length in `px`. They win over the
  page's own stylesheets' values for the same names, so a page may define them there as a plain browser's fallbacks
  (never in `:root`'s inline style, which would win over the wallet's). `grain.layout()` sets the same values where the
  wallet does not: an older wallet, or a plain browser from its own `env(safe-area-inset-*)`.
- `env(safe-area-inset-*)` is the browser's, not this contract: a wallet's web view may report all, part or none of
  the system's UI (Android's reports at most a cutout). Read the variables or `safe_area`; the larger of a variable and
  its `env()` is safe in both.
- `grain_setHeader {color}` gives the colour at the top of the page; the wallet draws its band (inside the safe area),
  the status bar's icons and its controls to contrast with it, until the next call.
- `grain_expand` changes nothing: a grain always opens as a full app.

A Saltix of bridge version 1 or 2, and Saltix 0.1.53 (bridge 3 before the frame), answers `safe_area {top: 0,
bottom: 0}` (no `left` or `right`) and no `controls`: its header sits above the page, which is what a page inside the safe area is told now. Read an absent
`controls` as none and any absent field as 0.

### 5.1. Identity

A grain sees the user under a **grain key**: a pseudonym of its own, the same on all of the user's devices, different
in every grain and unlinkable across grains.

```text
grain secret = the SLIP-0010 node m/44'/1010'/account'/3'/0' (its private key)
grain key    = the Ed25519 key whose seed is derive("Saltix grain key v1", grain secret ‖ slug)
```

The grain secret does not rotate; a phone with the phrase derives it, and a managed account's devices receive it.
`grain_login {challenge}` returns the grain key and its signature:

```text
GrainLogin { slug: String, origin: String, challenge: Vec<u8>, at: u64 }      challenge at most 64 bytes; at in Unix ms
signature by the grain key over derive("Saltix grain login v1", Borsh(GrainLogin))
answer: {key, signature, at, origin, member}    key and signature hex, at Unix ms, origin text; member: §5.1a
```

`origin` is the page's, as the system reports it (`https://<slug>.grain.invalid` for a sealed grain). The grain's
server checks the signature, its own slug and origin, the challenge it gave, and `at` within 5 minutes of its clock:
a sign-in without a password and without the account's address (`newChallenge`, `verifyLogin`).
`grain_requestAddress` gives the address itself, when the grain needs it and the user agrees.

### 5.1a. The team's sign-in: check first, render after

A grain key says nothing about the account. A page that shows some people more than others (its team's tools, a
private circle's content) must know who signs in **before** it shows them anything, so the sign-in carries the proof
the chat carries:

```text
grain_login {challenge} → {key, signature, at, origin, member}
member: lowercase hex of Borsh(SignedMemberProof) (grain-chats.md §3), or null
```

- **When the wallet attaches one**, by the grain's registry record: the account is on the grain's **team** (its owner,
  or a member with the developer or viewer role), public grain or private; or the grain is private and the account is
  a member with any role. Anyone else gets `member: null`, and so does an unlisted grain and a retired one. A public
  grain's users stay grain keys and nothing more.
- The proof is for this grain's slug (the bridge's own), for `key` as its `grain_key`, on this network, and lives at
  most 30 days. The wallet reuses the one its chat sends while it holds.
- **No consent of its own**: the sign-in is the one the Connect sheet agreed to (the team never sees that sheet for
  its own app), and members already prove themselves to their app in every chat request.
- A member's wallet that cannot sign the proof now (the unlock cancelled) refuses the sign-in with `5000` rather than
  answer `null`: a member is never taken for a stranger.
- **Old wallets.** A wallet that attaches proofs always puts `member` in the answer, the proof or `null`; Saltix 0.1.53
  and older put none at all. A page tells "not one of ours" (`null`) from "this wallet cannot say" (absent) by that,
  and asks the second to update Saltix. A server reads an absent `member` as `null`.

**The server's check**, as for a chat request ([grain chats §3](grain-chats.md#3-requests-what-the-user-sends)): the
login checks (§5.1); the proof is for its slug and the login's `key`, unexpired, ending at most 30 days and 5 minutes
after its clock, signed by a key that speaks for `account` now (the server asks its node); the account's roles come
from the registry as its node reads it now (`grain_get`). **Rights**, by the strongest role: `owner`, `developer`, `viewer`,
`user` (a private grain's member who only uses it), or `none` (no proof, a proof that fails, an account with no role).
A public grain's server takes only its team's proofs: a user role means nothing there. A node that does not answer
leaves the proof unread: the server says it cannot check now and refuses nothing for good. The SDK: `SignIns`,
`signInAnswer`, `rightsOf`.

**Check first, render after.** A page for some people only shows none of it before its server's answer:

- on a first open the Connect sheet comes first ([connect §12](connect.md#12-the-connect-sheet)); the page loads after
  Continue;
- until the sign-in resolves, a neutral splash: the app's icon and name, nothing of its UI;
- then the app for those it is for; or a refusal page with none of the app's UI (whom it is for, and that its owner can
  invite them); or, for a wallet that sends no `member`, that this Saltix cannot confirm membership and should be
  updated;
- the server checks every request of a session again: the page's gate is for what people see, never the only check.

A **private** grain never loads for anyone else at all: the wallet reads the registry before it fetches the page or
bundle (or draws a chat-only app's home) and shows only that the app is private and takes an invite, however it was
opened. (`grain.signIn` and `gateOf` in `@saltix/grain` do the page's part; [docs/agents/app.md](../agents/app.md#a-page-for-some-people-only-check-first-then-render)
shows the code.)

### 5.2. Payments

`grain_pay {to, asset, amount, memo?, invoice?}` opens the wallet's own transfer sheet above the grain: the grain's name
and form, verified or not (§9), the amount, the recipient and the memo. The user confirms with the PIN or biometrics;
the wallet signs, submits and returns the transaction id. Without a tap of the user in the last 5 seconds the sheet
does not appear.

An **invoice** makes the sheet trustworthy:

```text
Invoice        { slug: String, to: [u8; 32], asset: Asset, amount: u64,
                 memo: String (at most 200 bytes, no control characters), reference: [u8; 16], expires_at: u64 (Unix ms) }
InvoiceKeyCert { slug: String, key: [u8; 32], expires_at: u64,
                 signature: [u8; 64]   by owner_key over derive("Saltix grain invoice key v1", Borsh((slug, key, expires_at))) }
SignedInvoice  { invoice, cert: Option<InvoiceKeyCert>,
                 signature: [u8; 64]   by owner_key (no cert), cert.key, or a registered server key (no cert), over
                                       derive("Saltix grain invoice v1", genesis_hash ‖ Borsh(invoice)) }
```

The grain hands the wallet the hex of the signed invoice's Borsh in `grain_pay {invoice}`, or its server puts it in a
chat card ([grain chats §4](grain-chats.md#4-messages-what-the-app-sends)). The wallet checks that it is the grain's,
unexpired, of a positive amount, and signed by one of:

- **the manifest's owner key**, which must still speak for the owner (a device the owner removed signs nothing for its
  grains; the owner then updates the manifest with a key that does);
- **a key the owner key certified** for this grain (`InvoiceKeyCert`), while the certificate holds: to any payee. The
  same certificate lets that server key sign notifications (§5.5). The owner's own key stays off the server;
- **a server key the grain's registry record names** (`ConfigureGrain`), without a certificate, and then **only when
  `to` is the grain's owner account**, as the record has it when the wallet checks. This is how an app made in Saltix's
  app studio takes payments: its developer key is such a key.

For a registered key the wallet reads the record as its node holds it now, refuses any invoice of a retired grain
(whoever signed it), tries the owner key, then each key the record names, and takes a server key's invoice only when
`to` is the record's owner. So a leaked server key can ask users to pay only the owner; a key removed since it signed
signs nothing from the block that removed it; a grain the registry does not hold (opened by a manifest link) has no
server keys; and a wallet that cannot read the record says so (`5000`) and pays nothing. Saltix 0.1.53 and older know no
registered key for invoices and refuse such an invoice; a certificate works in every wallet. The refusals' names, which
the vectors and wallets share: `retired`, `signature` (no key that may sign verifies), `payee` (a server key's invoice
to anyone but the owner); `invoices.registered` in `vectors/grains-v1.json`.

The sheet reads "Invoice from <grain>". **The transfer's public memo is the reference in lowercase hex, a space, then
the invoice's text**, so the grain's server finds the payment on chain without trusting the page: it reads the payee's
`account_history` for a `received` or `receipt` entry whose memo starts with that reference, and checks its asset and
amount (`findPayment`, `referenceInMemo`). An invoice with no text has the reference alone as its memo, with no space
after it (`memoText`). Deliver on that, never on the page's or the user's word.

**Quick pay.** The user may allow one-tap payments to one grain, up to a sum per day it sets (at most 1 SALT a day; off
until the user turns it on): no PIN, but the sheet still shows every payment and needs a tap. SALT only; a larger sum,
WORK, or a wallet key that opens only after biometrics asks as for any payment.

The SDK: `signInvoice`, `issueInvoiceKeyCert`, `invoiceProblem` (as a wallet checks), `findPayment`;
[docs/payments.md](../payments.md) is the guide.

### 5.3. Storage

Up to 1 MiB per grain, encrypted and synced across the user's devices in the account's vault. Keys and values are
strings: keys of 1 to 128 bytes without U+0000, values of at most 60 KiB. It survives reinstalling the wallet and moving
to a new phone; it goes when the user removes the grain's data or the grain itself. Storage is kept by slug, for the
owner the phone first knew it under (§9).

### 5.4. Relays: real-time between users

A grain talks to other users of the same grain, and to its server, through the relays, under the user's grain key,
never under the account's address.

- **The grain alias.** `grain_relay_open {grant?}` → `{address}` registers the grain key at the wallet's relay as a
  *grain alias*: the grain key's personal address (kind 0), with a key binding the grain key signs for the **grain
  messaging key**, an X25519 key whose secret is `derive("Saltix grain messaging key v1", grain secret ‖ slug)`. It
  differs per grain and comes back with the phrase. The alias stays registered while the grain is open, or while its
  notifications are allowed (§5.5).
- **Frames.** `grain_relay_send {to, payload, keep?}`: `to` an address (another user's grain alias, or the grain's
  server), `payload` hex of at most 48 000 bytes. The wallet seals it to `to`'s messaging key and sends it as a relay
  `message` from the alias: live only, or with `keep` kept in `to`'s mailbox until `to`'s wallet takes it. Frames to the
  alias reach the page as `relay {from, payload}` events. The wallet checks every record itself, opens only frames to
  the grain's own alias, and drops what does not open. `grain_relay_close` unregisters the alias unless notifications
  keep it.
- **The sealed form**, which every wallet and server SDK reproduces:

  ```text
  payload of the relay message = base64url( nonce (24 bytes) ‖ crypto_box(plaintext, nonce,
                                            recipient's messaging key, sender's messaging secret) )
  ```

  NaCl `crypto_box` (X25519, XSalsa20-Poly1305), the recipient's messaging key taken from its checked address record
  ([relays](relays.md#messaging-keys-get_key)). Sealing adds 40 bytes and base64url a third, so the largest frame,
  64 054 characters, fits a relay's 64 KiB `payload`. A frame reaches the page as hex, twice its size: wallets before
  Saltix 0.1.55 drop an event over 64 KiB, so keep frames under about 32 KB.
- **Who pays.** When the manifest names a `sponsor`, the grain's server issues a **sponsor certificate** for the
  user's grain key at login (`user_key` the grain key, `sponsor` a key whose personal account is the manifest's
  `sponsor`; [relays](relays.md#sponsor-certificates)) and the page passes it as `grant`. The wallet checks it, asks the
  sponsor's exchange for an allowance for the grain key, and pays the relay for the alias with it: the alias's frames
  go on the sponsor's lane, within the certificate's `services` and `per_day`. Without a grant they use the relay's
  free share: the user's own channel never pays for a grain's traffic. The SDK: `grantFor`, `grain sponsor`.

### 5.5. Notifications

`grain_notifications_allow` asks the user once whether the grain may notify them; the answer is kept and revocable.
While allowed, the wallet keeps the grain alias registered, so frames to it reach the phone with the grain closed. A
notification is a kept relay `message` to the alias whose sealed payload is:

```text
GrainNotification {
  slug:   String
  title:  String           1–64 characters, no control characters
  body:   String           at most 256 characters, no control characters
  start:  Option<String>   1–64 of [A-Za-z0-9_-]: opens the grain with it (§4)
  at:     u64              Unix ms
}
SignedGrainNotification { notification, cert: Option<InvoiceKeyCert>, signature: [u8; 64] }
  by the key `cert` certifies, or without a certificate by the owner key or a server key the registry record names,
  over derive("Saltix grain notification v1", genesis_hash ‖ Borsh(notification))
```

The wallet shows it as the grain's notification (not as a chat message) when the signature checks against the
manifest's owner key that still speaks for the owner, a certified key, or a server key the registry names as the
wallet's node reads it now (a removed key signs nothing from the block that removed it on); the slug is the grain's; `at` is at most 7
days old and not more than 5 minutes ahead; and the grain has shown fewer than 10 today (100 to an account on the
grain's team; unasked chat messages count with them). Tapping it opens the grain with `start`. While the grain is
closed, anything else to its alias is taken off the mailbox and dropped: a grain keeps its history on its server.

**A grain's server at a relay** registers like any client under its own key (better a server key than the owner's),
with an address record that key signs itself and a binding to its messaging key, whose secret is
`derive("Saltix grain server messaging key v1", the key's Ed25519 secret)`: one key keeps one messaging key across
restarts and SDKs, and users' wallets keep sealing to it ([relays](relays.md#registering-an-address)). It pays for its
frames like any sender. The SDK: `RelayClient`, `signNotification`, `notificationProblem`.

## 6. Permissions

| Bit | Permission | Asked |
|---|---|---|
| 1 | `storage` | granted with the manifest |
| 2 | `relay` | granted with the manifest |
| 4 | `notifications` | when the grain asks (§5.5) |
| 8 | `camera` | by the wallet's native prompt, per grain, when the page first asks |
| 16 | `microphone` | the same |
| 32 | `location` | the same |
| 64 | `address` | when the grain asks (§5.1) |

A grain gets nothing its manifest does not list. The first time an account opens a grain, the wallet shows what it
asks for on the Connect sheet ([connect §12](connect.md#12-the-connect-sheet)), where `address` and `notifications` are
switches the user may leave off and still sign in (asking for them later takes a tap, §5). The user sees and revokes
what each grain has in the grain's ⋯ sheet and in Settings → Connected apps and sites. `grain lint` warns about a
permission nothing in the app's sources uses.

## 7. Security of the container

- **One grain, one WebView, one profile.** No cookies, storage or cache shared with the browser or other grains; no file
  or content access; no other windows; mixed content refused.
- **Origin lock.** Navigation outside the manifest's origins opens in the wallet's browser, without the bridge.
- **The page's frame: safe by default, edge to edge on request.** A grain opens as a full app with no header of the
  wallet's over it:
  - **Inside the safe area, by default.** The page's viewport is the window less the system's UI (below the status bar
    and any cutout, above the navigation bar or gesture area and an open keyboard, clear of rounded corners and side
    insets) and below a **band** of 56 dp at the top that holds the wallet's controls. A page that knows nothing of
    insets never draws under any of it. The band takes the colour the page gives with `grain_setHeader`, else its
    `<meta name="theme-color">`, else its background; the margins take its `theme-color` or background.
  - **Edge to edge, when the page asks.** A page that declares `viewport-fit=cover` is drawn under the status bar, the
    cutout and the navigation bar, never under an open keyboard. It keeps its text and controls inside `safe_area` and
    its tappable elements out of `controls` (§5). The declaration is the content of the document's last `<meta
    name="viewport">`, split at commas, semicolons and white space into `key=value` pairs (white space allowed around
    `=`), keys and values ASCII case-insensitive; the last `viewport-fit` decides: `cover` is edge to edge; `auto`,
    `contain`, anything else and no meta at all are the safe area. The wallet reads it as the document is parsed, with
    a script that runs before the page's, and follows a change of the meta; a new document keeps the frame of the one
    before until its head has been read. A page in another origin's frame stays inside the safe area.
  - **The controls** `⋯ | ✕` float in the top right corner of the window's safe area, at the same place both ways: a
    translucent capsule of 96 × 48 dp (two 48 dp targets), 8 dp from the right inset and 4 dp below the top one, named
    for screen readers. The page can neither draw over it nor hide it. **✕** closes the grain; the system's **Back**
    goes back in the page's own history first, then closes it; **⋯** opens the wallet's sheet for the grain (its icon,
    name, form and mark, the app's chat, Manage for its team, Awaiting you for its owner, Share, Reload, quick pay and
    permissions, Report and Forget), never inside the page.
  - While the page loads, the wallet shows the grain's icon and name over its own background, with a thin progress
    line at the top; it goes once the page has loaded (`grain_ready` neither holds nor hides it).
  - Every sheet that touches money, identity or permissions is native, above the grain, and the PIN pad is the
    wallet's (screenshots blocked).
  - CSS pixels are dp on Android and points on iOS, the same frame on every platform. The top and bottom insets are
    each at least about 0.29 r for the screen's corner radius r (the depth of the arc's 45° point), so content kept
    that far from the edges is never clipped.
- **Nothing secret is typed into a grain.** A wallet never asks for the phrase or the PIN inside a grain's area, and
  says so the first time a grain opens; a grain that asks for either is phishing and leaves every wallet's list.
- **Keys never cross.** No bridge method returns a private key, a seed, a vault key or a message; the wallet signs only
  domain-separated statements naming the grain (`grain_login`, `grain_pay`), worthless to another grain.
- **Sealed grains** are served from the virtual origin `https://<slug>.grain.invalid/` once the bundle's hash matches,
  and the wallet blocks every request outside `connect` (§8).
- **Limits.** Bridge calls are rate-limited per method. A grain closed in the background keeps no bridge.

`grain dev`'s simulator frames a page as Saltix does, both ways, at a phone's size, the Galaxy Z Fold's 475×751,
704×932 and 932×704 dp, and an iPhone-like screen, and holds every request to these rules (`@saltix/grain/rules`).

## 8. Sealed bundles

A bundle is a ZIP of the grain's files, at most 20 MiB. `bundle = derive("Saltix grain bundle v1", its bytes)`;
`sources` lists where to fetch it (HTTPS, or a relay's file store). The wallet downloads it from any source, checks the
size and the hash, unpacks it into the grain's private directory and serves `start` from the virtual origin. A new
version is a new manifest; the wallet shows what changed in permissions before running it.

So that a bundle one wallet runs every wallet runs, it holds at most 4 096 files and 64 MiB unpacked, with names of
`/`-separated parts of `[A-Za-z0-9._ ~@+-]`, none `.` or `..`, each name once. A wallet refuses any other bundle whole.
It serves every file with a Content-Security-Policy whose `connect-src` (and images and media) allows only the origin
itself and the manifest's `connect` origins (`https://` and `wss://`), and refuses other requests. The manifest of a
sealed grain opened by link is served at one of its sources' origins.

`grain bundle` makes the same bytes from the same files on any computer (sorted, no times, every file stored, never
deflated) and fills in `bundle`, `size`, `sources`, `start` and `connect`.

## 9. Wallets

The protocol defines grains; each wallet decides how it lists them. Saltix:

- **lists** its own apps, then grains: *verified* (a list Saltix publishes and signs after reviewing a grain's manifest
  and behaviour), then the registry by search, then recently opened. *Verified* is Saltix's word about a grain, not the
  network's; a grain proven harmful leaves the list and Saltix may refuse to open it;
- shows **the Connect sheet** on the first open of any grain, verified or not ([connect §12](connect.md#12-the-connect-sheet)):
  its identity, its Connect profile as its owner's words, what it asks for, and Continue or Cancel; for an unlisted
  grain or one outside the verified list also its owner's address (once the owner key is seen to speak for it) and its
  form;
- opens the registry's manifest for a manifest link to a registered slug when it is the same owner's, and refuses it
  when it is another's (an impostor);
- keeps storage and consents by slug, for one owner: a grain of another owner under a slug the phone knows opens only
  after the user removes the old one.

## 10. For developers

| Tool | What it does |
|---|---|
| `@saltix/grain` | the bridge with types and events; `inWallet()`; outside a wallet, `walletLink()`, the link that opens the grain in one; `grain.layout()` |
| `@saltix/grain-server` | checks sign-ins and invoices, finds payments on chain through a node, issues sponsor certificates, signs manifests, notifications and the registry's calls, writes to users through the relays, serves a chat |
| `grain` command line | `init`, `dev`, `lint`, `icon`, `sign`, `bundle`, `publish`, `retire`, `show`, `profile`, … ([README](../../README.md#the-command-line)) |
| Simulator | the wallet's side of the bridge in a desktop browser, framed as a wallet frames a page (§7) |
| Test network | its faucet (`grain faucet`), its registry |

**Publishing from the wallet.** The owner of a grain is a wallet account; its key signs the manifest and pays the
deposit without leaving the phone:

1. The tool shows a QR code of `salt:grain-publish?m=<manifest>`, where `<manifest>` is base64url without padding of
   the raw DEFLATE (RFC 1951) of the manifest's Borsh form with `owner` 32 zero bytes and `owner_key` the Ed25519 key
   of 32 zero bytes: the wallet fills them in. The link is at most 2 048 characters and the manifest inflates to at most
   16 384 bytes; a larger manifest is published with a key file.
2. The wallet sets `owner` to its account and `owner_key` to the key that speaks for it, checks the manifest, and asks
   the registry for the slug: unregistered → `RegisterGrain` with the slug's deposit; registered by this account, live,
   at a lower version → `UpdateGrain`; anything else is refused.
3. It shows the grain (name, slug, version, form and origins, permissions, sponsor) and what it costs, and after the
   PIN (for a managed account its phrase too, or a quorum) signs the manifest and the transaction and submits it.
4. The tool watches the registry until the slug holds the manifest it showed (equal but for `owner`, `owner_key` and
   `signature`), then writes the signed JSON form the grain's origin serves.

**From the app's console.** An app's program may propose its update in its chat instead: a card with a `Publish`
action carries the same `<manifest>`, and only the grain's team's wallets show it; the owner's **Review and approve**
opens this flow at step 2 ([grain chats §4](grain-chats.md#4-messages-what-the-app-sends)). The wallet never signs a
manifest outside this flow: a page or a grain cannot ask for it.

**The Connect profile.** Every grain ships one ([connect §11](connect.md#11-the-connect-profile)). The owner writes it
in Saltix's app studio, or the developer keeps it in the project (`connect.json`: the JSON form's `profile` object
without `owner` and `revision`), checks it with `grain lint` and sets it with `grain profile`: a QR code of
`salt:grain-profile?p=<profile>`, `<profile>` being base64url without padding of the raw DEFLATE of the profile's
Borsh form with `owner` 32 zero bytes and `revision` 0, at most 2 048 characters in all, inflating to at most 8 192
bytes. The wallet fills in `owner` and a `revision` one above the registry's, checks it, shows it as the Connect sheet
will, and after the PIN signs it and sends `SetGrainProfile`. It takes such a link only for a live grain the account
owns. A profile too long for the link is set in the studio, or with a key file on test networks.

**Developer origins.** A wallet's developer build also takes `http://localhost`, `http://127.0.0.1` and the Android
emulator's `http://10.0.2.2`, with any port, as a hosted grain's origins, so `grain dev` needs no certificate. A
release wallet never does.

## 11. Parameters

| Name | Value |
|---|---|
| Deposit | 100 SALT for a slug of 3–5 characters, 30 for 6–7, 10 for 8 or more; returned 30 days after `RetireGrain` |
| `GRAIN_RELEASE` | 2 592 000 slots (30 days) |
| Storage per grain | 1 MiB; keys 1–128 bytes, values at most 60 KiB |
| Bundle | 20 MiB; 4 096 files and 64 MiB unpacked |
| Quick pay | at most 1 SALT a day per grain; the user may set less |
| A bridge answer or event | 64 KiB |
| A tap before `grain_pay`, `grain_chat_open`, `grain_manage_open` | within 5 seconds |
| Grain aliases per relay connection | 32, besides 8 ordinary aliases |
| `grain_relay_send` payload | 48 000 bytes |
| Notifications shown | 10 a day per grain, 100 to its team; at most 7 days old |
| A sign-in's `at` | within 5 minutes of the server's clock |
| Connect profile | 8 192 bytes in Borsh; the profile link at most 2 048 characters |
| The wallet's controls | a box of 96 × 48 dp, 8 dp from the right inset and 4 dp below the top inset; reported in CSS pixels, which equal dp in a grain's view |
| The band | 56 dp above a page inside the safe area, below the top inset |
