// The sign-in of a grain's page (Saltix 12-grains §5.1, §5.1a): a challenge the server gives, the user's grain key's
// signature through `grain.login`, and from the grain's team (and a private grain's members) the member proof the chat
// already sends. `SignIns` checks all of it and says who signed in and what they may do, so that the page shows
// nothing before it knows: check first, render after. The page side is `grain.signIn()` in `@saltix/grain`, which
// posts to the two routes a server answers with it:
//
//   POST <url>challenge   → {challenge}                           (`signIns.challenge()`)
//   POST <url>session     ← {challenge, key, signature, at, origin, member?, …your fields}
//                         → {signed_in, rights, …your fields}     (`await signIns.check(body)`, then `signInAnswer`)
//
// No Node APIs here beyond what the login check uses: a server of any framework calls it.
import { type NetworkName, accountId, encodeAddress } from "./address.js";
import { fromHex } from "./bytes.js";
import type { ChatServer } from "./chat-server.js";
import { newChallenge, verifyLogin } from "./login.js";
import { type MemberProblem, type Rights, type SignedMemberProof, decodeSignedMemberProof } from "./member.js";

/** How long a challenge waits for its sign-in: two minutes. */
export const SIGN_IN_CHALLENGE_MS = 2 * 60_000;
/** Challenges held at once, at most: the oldest goes first. A server's rate limits keep it far below. */
export const SIGN_IN_CHALLENGES = 1024;
/** The longest `member` taken: hex of a `SignedMemberProof`, whose Borsh is about 210 bytes. */
const MAX_MEMBER_HEX = 1024;

/** The virtual origin a wallet serves a sealed grain's page at (12-grains §8): what its sign-ins name. */
export const sealedOrigin = (slug: string): string => `https://${slug}.grain.invalid`;

/** Who signed in, as `SignIns.check` found it. */
export interface SignedIn {
  /** The user's grain key, hex: their id in this grain, the same in its page and its chat. */
  key: string;
  /** The grain key's personal address on the network: where the grain's chat reaches them (`ChatAsk.user`). */
  address: string;
  /** What they may do, by the registry's roles: `none` for anyone the wallet proved nothing of. */
  rights: Rights;
  /** The account the member proof showed, hex; null without one that checked. */
  account: string | null;
  /** The account's roles, a bit set of `ROLES`; 0 without a proof that checked. */
  roles: number;
  /**
   * Whether the wallet attaches member proofs: it put `member` in its answer, the proof or `null`. False for Saltix
   * 0.1.53 and older, whose `none` may be a member it cannot show: ask them to update Saltix, never tell them the app
   * is not for them.
   */
  proves: boolean;
  /** Why a proof that came was not taken (`malformed`: not a member proof at all); null when it was, or none came. */
  problem: MemberProblem | "malformed" | null;
}

/** What `SignIns.check` answers: who signed in, or why nobody did (`challenge`: not one given here, spent or
 *  expired; `login`: the answer does not sign it for this grain and origin). */
export type SignInResult = { ok: true; signedIn: SignedIn } | { ok: false; reason: "challenge" | "login" };

/** Who a member proof shows is behind a grain key: `ChatServer.member`, or your own check of it. */
export type MemberCheck = (proof: SignedMemberProof | null, key: string) => Promise<{
  account: string | null;
  roles: number;
  rights: Rights;
  problem: MemberProblem | null;
}>;

export interface SignInOptions {
  /** The grain's slug, as its sign-ins name it. */
  slug: string;
  /** The page's origin as the wallet reports it: the hosted origin, or `sealedOrigin(slug)` for a sealed grain. */
  origin: string;
  /** The network the grain is on: the address of a grain key is of it. */
  network: NetworkName;
  /** Who a member proof shows signs in (`chat.member`, which `SignIns.of(chat)` passes). Without it every sign-in has
   *  the rights `none`: a server with no registry cannot tell its team. */
  members?: MemberCheck;
  now?: () => number;
  /** How long a challenge waits (`SIGN_IN_CHALLENGE_MS` by default). */
  challengeMs?: number;
}

/**
 * A grain page's sign-ins (12-grains §5.1, §5.1a): challenges given and spent once, and each answer checked — the
 * grain key's login for this slug and origin within five minutes, then the member proof it carried, through `members`.
 * Answer the page with `signInAnswer`; keep the session (a token of your own) bound to `signedIn.key`, and check the
 * rights again on every request it makes: the page's gate decides what people see, never what they may do.
 */
export class SignIns {
  private readonly challenges = new Map<string, number>();
  private readonly now: () => number;
  private readonly life: number;

  constructor(private readonly o: SignInOptions) {
    if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(o.slug)) throw new TypeError("slug: 3 to 32 of [a-z0-9-], not starting with -");
    this.now = o.now ?? Date.now;
    this.life = o.challengeMs ?? SIGN_IN_CHALLENGE_MS;
  }

  /** Sign-ins to the page of `chat`'s grain, its members read from the registry by `chat.member`; `origin` is the
   *  sealed grain's virtual one unless given (a hosted grain's https origin). */
  static of(chat: ChatServer, options: { origin?: string; now?: () => number; challengeMs?: number } = {}): SignIns {
    return new SignIns({
      slug: chat.slug, origin: options.origin ?? sealedOrigin(chat.slug), network: chat.chain.network,
      members: (proof, key) => chat.member(proof, key), now: options.now, challengeMs: options.challengeMs,
    });
  }

  /** A new challenge (32 random bytes, hex) for `grain.login`, kept until it is spent or `challengeMs` passed. */
  challenge(): string {
    const t = this.now();
    for (const [c, until] of this.challenges) if (until <= t) this.challenges.delete(c);
    while (this.challenges.size >= SIGN_IN_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    const c = newChallenge();
    this.challenges.set(c, t + this.life);
    return c;
  }

  /**
   * Check what the page posted (`{challenge, key, signature, at, origin, member?}`): the challenge one of ours,
   * unspent and unexpired, and spent now whatever follows; the login the grain key's for this slug and origin within
   * five minutes; then the member proof, when one came (`members`). A `member` that is not a member proof counts as
   * none (`malformed`). Throws what `members` throws (`ChatMemberUnchecked`: the node did not answer, so answer the page
   * to try again, never that it is not one of yours).
   */
  async check(body: unknown): Promise<SignInResult> {
    const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const challenge = typeof b.challenge === "string" ? b.challenge : "";
    const until = this.challenges.get(challenge);
    if (until === undefined) return { ok: false, reason: "challenge" };
    this.challenges.delete(challenge);
    const t = this.now();
    if (until <= t) return { ok: false, reason: "challenge" };
    const formed = typeof b.key === "string" && /^[0-9a-f]{64}$/.test(b.key) && typeof b.signature === "string" &&
      /^[0-9a-f]{128}$/.test(b.signature) && Number.isSafeInteger(b.at) && (b.origin === undefined || typeof b.origin === "string");
    if (!formed) return { ok: false, reason: "login" };
    const key = b.key as string;
    const signed = verifyLogin(
      { key, signature: b.signature as string, at: b.at as number, origin: b.origin as string | undefined },
      { slug: this.o.slug, origin: this.o.origin, challenge, now: t },
    );
    if (!signed) return { ok: false, reason: "login" };
    const address = encodeAddress(this.o.network, accountId(fromHex(key, 32)));
    const proves = Object.hasOwn(b, "member");
    const base = { key, address, proves };
    let proof: SignedMemberProof | null = null;
    if (typeof b.member === "string") {
      try {
        if (b.member.length > MAX_MEMBER_HEX) throw new RangeError("too long");
        proof = decodeSignedMemberProof(fromHex(b.member));
      } catch {
        return { ok: true, signedIn: { ...base, rights: "none", account: null, roles: 0, problem: "malformed" } };
      }
    } else if (b.member !== undefined && b.member !== null) {
      return { ok: true, signedIn: { ...base, rights: "none", account: null, roles: 0, problem: "malformed" } };
    }
    if (proof === null || !this.o.members) return { ok: true, signedIn: { ...base, rights: "none", account: null, roles: 0, problem: null } };
    const m = await this.o.members(proof, key);
    return { ok: true, signedIn: { ...base, rights: m.rights, account: m.account, roles: m.roles, problem: m.problem } };
  }
}

/**
 * The answer to the page's `session` route that `grain.signIn()` reads: `signed_in` (whether your server gave a
 * session: only when `admitted`), `rights`, and whatever else you add (a token, the user's settings). Never send a
 * token to someone you do not admit.
 */
export function signInAnswer(signedIn: SignedIn, admitted: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, signed_in: admitted, rights: signedIn.rights };
}
