/**
 * `@saltix/grain-server`: the server side of a grain (Saltix 12-grains, 22-grain-chats, 24-app-studio: docs/protocol/)
 * — check sign-ins, make and sign invoices, find their payments on chain, sign the manifest and the Connect profile
 * (19-connect §11), the registry's calls,
 * write to users through the relays (frames and notifications), and talk with them in the grain's chat
 * (`ChatServer`, from a developer key alone), its team included: errors reach the team in the app's console. Byte for
 * byte the node's formats (vectors/grains-v1.json, vectors/grain-chats-v1.json, vectors/handles-v1.json,
 * vectors/connect-profiles-v1.json, vectors/server-pairing-v1.json, vectors/images-v1.json, vectors/gate-v1.json). A
 * server pairs its key with its app by a QR code (`pairing.ts`, `grain pair`) and finds it with `appKeyFromEnvironment`;
 * on a test network whose relays require access grants, a key the registry does not name yet shows one (`access.ts`,
 * `gate.ts`: 33-gate). A sealed app's bundle and icon go into the network itself (`named.ts`: the checks,
 * `bundle-upload.ts`: the server key's statement, `blobs.ts`: `putBundle`, `putIcon`, `getBlob`).
 * `@saltix/grain-server/web` holds the parts that run in a web page too.
 */
export * from "./bytes.js";
export * from "./address.js";
export * from "./keys.js";
export * from "./manifest.js";
export * from "./login.js";
export * from "./invoice.js";
export * from "./node.js";
export * from "./tx.js";
export * from "./registry.js";
export * from "./handle.js";
export * from "./keylog.js";
export * from "./profile.js";
export * from "./profile-link.js";
export * from "./sponsor.js";
export * from "./notification.js";
export * from "./records.js";
export * from "./seal.js";
export * from "./relay.js";
export * from "./file.js";
export * from "./member.js";
export * from "./stats.js";
export * from "./publish.js";
export * from "./publish-link.js";
export * from "./chat.js";
export * from "./upload.js";
export * from "./named.js";
export * from "./bundle-upload.js";
export * from "./blobs.js";
export * from "./chat-card.js";
export * from "./card-standard.js";
export * from "./card-lint.js";
export * from "./chat-store.js";
export * from "./report.js";
export * from "./app-key.js";
export * from "./key-file.js";
export * from "./pairing.js";
export * from "./access.js";
export * from "./gate.js";
export * from "./network.js";
export * from "./chat-server.js";
export * from "./sign-in.js";
