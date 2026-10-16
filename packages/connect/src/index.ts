/**
 * `@saltix/connect`: "Sign in with Saltix" for websites and DApps (Saltix 19-connect §2–§5, §13). The page's side of
 * Saltix Connect — the session's keys, the link slot through relays the page reaches, the offer as a QR code and a link,
 * the grant's checks (the account's key event log included), the connection kept for 30 days — with the button and the
 * dialog of the standard. Framework-free, for the browser. A port of the explorer's tested `explorer/src/connect/`,
 * byte for byte vectors/connect-v1.json. A site's own Connect profile is signed once by its operator with
 * `grain connect-profile` (the server SDK's `signProfile`), never in a page; `readSiteProfile` checks it as a wallet does.
 */
export * from "./client.js";
export * from "./button.js";
export * from "./dialog.js";
export * from "./words.js";
export { MARK_PATH } from "./mark.js";
export * from "./offer.js";
export * from "./grant.js";
export * from "./seal.js";
export * from "./relay.js";
export * from "./session.js";
export * from "./store.js";
export * from "./verify.js";
export * from "./node.js";
export * from "./qr.js";
export * from "./site.js";
export { b64url, fromB64url, fromB64Loose } from "./codec.js";
