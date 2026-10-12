import { ed25519 } from "@noble/curves/ed25519";
import { randomBytes } from "@noble/hashes/utils";
import { Writer, derive, fromHex, toHex } from "./bytes.js";

/** How far a login's time may be from the server's (12-grains §5.1). */
export const LOGIN_SKEW_MS = 5 * 60_000;

/** A fresh challenge for `grain.login`: 32 random bytes, hex. Keep it until the answer comes. */
export function newChallenge(): string {
  return toHex(randomBytes(32));
}

/** What `grain_login` signs: Borsh of `GrainLogin {slug, origin, challenge, at}` under its domain. */
export function loginMessage(slug: string, origin: string, challenge: Uint8Array, at: number | bigint): Uint8Array {
  const body = new Writer().string(slug).string(origin).bytes(challenge).u64(at).done();
  return derive("Saltix grain login v1", body);
}

export interface LoginAnswer {
  key: string;
  signature: string;
  at: number;
  origin?: string;
}

/**
 * Whether `answer` (what `grain.login(challenge)` returned in the page) signs in a user of the grain
 * `slug` served at `origin`: the challenge you gave, a time within 5 minutes of `now`, and the
 * signature of the user's grain key. On success, `answer.key` is the user's id in your grain.
 */
export function verifyLogin(
  answer: LoginAnswer,
  expected: { slug: string; origin: string; challenge: string; now?: number },
): boolean {
  try {
    const now = expected.now ?? Date.now();
    const challenge = fromHex(expected.challenge);
    if (challenge.length > 64 || Math.abs(answer.at - now) > LOGIN_SKEW_MS) return false;
    if (answer.origin !== undefined && answer.origin !== expected.origin) return false;
    const message = loginMessage(expected.slug, expected.origin, challenge, answer.at);
    return ed25519.verify(fromHex(answer.signature, 64), message, fromHex(answer.key, 32));
  } catch {
    return false;
  }
}
