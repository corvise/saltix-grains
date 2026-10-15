// Usernames and numbers (Saltix 21-names): what a grain's owner binds to the grain with `BindHandle` (24-app-studio §2),
// so that `@name` opens the app's chat. Their canonical forms, how typed text reads, how wallets write them, and their
// Borsh, byte for byte vectors/handles-v1.json.
import { Writer } from "./bytes.js";

/** A name (`@anna_k`: 1–32 of `a-z 0-9 _`, a letter first, no `__`, not ending in `_`) or a number (the 4–10 digits after
 *  `+0`, the first 1–9). */
export type Handle = { name: string } | { number: string };

const NAME_MAX = 32;
const NUMBER_MIN = 4;
const NUMBER_MAX = 10;

/** Why `h` is not a canonical handle (`"name"` or `"number"`), or null. Reserved names are the mint's to refuse. */
export function handleProblem(h: Handle): "name" | "number" | null {
  if ("name" in h) {
    const n = h.name;
    const ok = n.length >= 1 && n.length <= NAME_MAX && /^[a-z][a-z0-9_]*$/.test(n) && !n.includes("__") && !n.endsWith("_");
    return ok ? null : "name";
  }
  const d = h.number;
  return d.length >= NUMBER_MIN && d.length <= NUMBER_MAX && /^[1-9][0-9]*$/.test(d) ? null : "number";
}

/**
 * What a person typed, as a handle, or null (Saltix `Handle::parse`): `+0` and digits, spaces and dashes dropped, is a
 * number; anything else a name, `@` optional and lowercased. White space around it is dropped.
 */
export function parseHandle(typed: string): Handle | null {
  const text = typed.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const handle: Handle = text.startsWith("+0")
    ? { number: text.slice(2).replace(/[ -]/g, "") }
    : { name: (text.startsWith("@") ? text.slice(1) : text).replace(/[A-Z]/g, (c) => c.toLowerCase()) };
  return handleProblem(handle) === null ? handle : null;
}

/** How wallets write it: `@anna`; a number in groups of four from the right, `+0 777 1234`. */
export function displayHandle(h: Handle): string {
  if ("name" in h) return `@${h.name}`;
  const d = h.number;
  const first = d.length % 4 === 0 ? 4 : d.length % 4;
  const groups = [d.slice(0, first)];
  for (let i = first; i < d.length; i += 4) groups.push(d.slice(i, i + 4));
  return `+0 ${groups.join(" ")}`;
}

/** Borsh of a handle: tag 0 Name(String) or 1 Number(String). */
export function writeHandle(w: Writer, h: Handle): Writer {
  return "name" in h ? w.u8(0).string(h.name) : w.u8(1).string(h.number);
}

export const encodeHandle = (h: Handle): Uint8Array => writeHandle(new Writer(), h).done();
