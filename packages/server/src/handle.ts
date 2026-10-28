// Usernames (Saltix 21-names): what a grain's owner binds to the grain with `BindHandle` (24-app-studio §2), so that
// `@name` opens the app's chat. Their canonical form, how typed text reads, how wallets write them, and their Borsh,
// byte for byte vectors/handles-v1.json. The numbers (`+0 777 1234`) left with the v15 genesis (2026-10-25): their
// Borsh tag 1 decodes as nothing on chain, and typed text of their form reads as no handle.
import { Writer } from "./bytes.js";

/** A name: `@anna_k`, 1–32 of `a-z 0-9 _`, a letter first, no `__`, not ending in `_`. */
export type Handle = { name: string };

const NAME_MAX = 32;

/** Why `h` is not a canonical handle (`"name"`), or null. Reserved names are the mint's to refuse. */
export function handleProblem(h: Handle): "name" | null {
  const n = h.name;
  const ok = typeof n === "string" && n.length >= 1 && n.length <= NAME_MAX && /^[a-z][a-z0-9_]*$/.test(n) && !n.includes("__") && !n.endsWith("_");
  return ok ? null : "name";
}

/**
 * What a person typed, as a handle, or null (Saltix `Handle::parse`): a name, `@` optional and lowercased, white space
 * around it dropped. A number's old form (`+0 777 1234`) and bare digits read as nothing.
 */
export function parseHandle(typed: string): Handle | null {
  const text = typed.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const handle: Handle = { name: (text.startsWith("@") ? text.slice(1) : text).replace(/[A-Z]/g, (c) => c.toLowerCase()) };
  return handleProblem(handle) === null ? handle : null;
}

/** How wallets write it: `@anna`. */
export const displayHandle = (h: Handle): string => `@${h.name}`;

/** Borsh of a handle: tag 0 Name(String), the only kind there is. */
export function writeHandle(w: Writer, h: Handle): Writer {
  return w.u8(0).string(h.name);
}

export const encodeHandle = (h: Handle): Uint8Array => writeHandle(new Writer(), h).done();
