// Putting named blobs into the network and reading them back (Saltix 32-images §7–§8, docs/protocol/images.md), through
// a node's wallet interface or a relay's gateway (`NodeLike`): no server of the developer's in between.
//
// - A sealed grain's bundle goes up in pieces of at most 256 KiB (`blob_put {kind: "grain_bundle", hash, size, from,
//   data, upload?}`), each where the last ended. An upload lives on the node that took its first piece: a piece out of
//   place (a node that lost the session, another relay answering after a failover) is refused `offset` with `received`,
//   and the upload goes on from there, from 0 at a node that never saw it. `busy` and `rate_limited` wait and try again;
//   a network failure tries again; any other refusal ends it with its reason (`BlobRefused`).
// - With `upload`, a server key's statement (`signBundleUpload`), the node holds a bundle no manifest names yet pending
//   for a day; without it, only a bundle the registry names is taken (`not_named`).
// - An icon goes up whole once the registry names it (`blob_put {kind: "grain_icon", data}`).
//
// Logs carry event names and numbers only, never a hash, a slug or a key.
import { fromBase64, toBase64, toHex } from "./bytes.js";
import { type NodeLike, RpcError, nodeCall } from "./node.js";
import { type SignedBundleUpload, encodeSignedBundleUpload } from "./bundle-upload.js";
import { BLOB_PIECE, type NamedKind, namedHash, namedProblem } from "./named.js";

/** Every reason a node gives `blob_put` (32-images §7.3), and two of the SDK's own: `check`, the bytes fail the check
 *  here before anything is sent, and `stuck`, the upload stopped moving. */
export type BlobReason =
  | "kind" | "not_named" | "size" | "format" | "method" | "files" | "name" | "unpacked" | "hash" | "slug" | "key" | "time"
  | "signature" | "offset" | "busy" | "pending" | "full" | "store" | "rate_limited" | "dimensions" | "depth" | "alpha"
  | "metadata" | "animation" | "stuck";

/** Refusals a later try may get past: the node is busy, over its rate, or its registry is behind the one that answered. */
export const TRANSIENT_BLOB_REASONS: ReadonlySet<string> = new Set(["busy", "rate_limited"]);

/** A node refused a blob for good, or the upload gave up: `reason` is the node's word (or `stuck`, `unreachable`). */
export class BlobRefused extends Error {
  constructor(public readonly reason: string, public readonly detail?: string) {
    super(`the network refused the blob: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "BlobRefused";
  }
}

/** A node's answer to a bundle's piece. */
interface PutAnswer {
  kind: string;
  hash: string;
  received?: number;
  kept: boolean;
  pending?: boolean;
}

/** The refusal's reason and where an upload stands, from a node's error answer. */
function refusalOf(e: unknown): { reason: string; received: number | null } | null {
  if (!(e instanceof RpcError)) return null;
  const data = e.data as { reason?: unknown; received?: unknown } | null;
  if (!data || typeof data.reason !== "string") return null;
  const received = typeof data.received === "number" && Number.isSafeInteger(data.received) && data.received >= 0 ? data.received : null;
  return { reason: data.reason, received };
}

export interface PutOptions {
  /** Progress: the bytes the node holds of `size`. */
  onProgress?: (received: number, size: number) => void;
  /** Events worth logging (names and numbers only). */
  log?: (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;
  /** Waits between tries; tests pass one that does not wait. */
  pause?: (ms: number) => Promise<void>;
  /** How long a node may stay busy, over its rate or unreachable before the upload gives up, ms: 10 minutes. */
  patienceMs?: number;
  /** The clock `patienceMs` runs on. */
  now?: () => number;
}

export interface BundlePutOptions extends PutOptions {
  /** A server key's statement for a bundle no manifest names yet; without it the registry must name the bundle. */
  upload?: SignedBundleUpload | null;
  /** `not_named` is tried again for this long, ms (0: refused at once): the registry names the bundle at the node that
   *  answered `grain_get`, and the node taking the pieces may be a block behind. */
  namedGraceMs?: number;
}

/** What became of an upload. */
export interface BundlePut {
  hash: string;
  size: number;
  /** True while no manifest names it: the node holds it on the statement's word, for its day. */
  pending: boolean;
  /** Pieces sent, pieces sent again after an `offset`, and tries after a wait. */
  pieces: number;
  resumed: number;
  retries: number;
}

const WAIT_FIRST_MS = 2_000;
const WAIT_MAX_MS = 30_000;
const PATIENCE_MS = 10 * 60_000;
const defaultPause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits after transient failures: 2 s doubling to 30 s, until `patience` has passed. */
class Backoff {
  private tries = 0;
  private since: number | null = null;
  /** Every wait so far, never reset. */
  waits = 0;
  constructor(private readonly o: Required<Pick<PutOptions, "pause" | "now">> & { patience: number }) {}
  /** Wait before the next try; false when patience ran out. */
  async wait(): Promise<boolean> {
    const now = this.o.now();
    this.since ??= now;
    if (now - this.since >= this.o.patience) return false;
    this.tries++;
    this.waits++;
    await this.o.pause(Math.min(WAIT_MAX_MS, WAIT_FIRST_MS * 2 ** (this.tries - 1)));
    return true;
  }
  /** The node took a piece: a later wait starts short again. */
  reset(): void {
    this.tries = 0;
    this.since = null;
  }
}

/** Whether an error is the network's (nothing answered), not a node's answer. */
const unreachable = (e: unknown) => !(e instanceof RpcError) && !(e instanceof BlobRefused);

/**
 * Put a sealed grain's bundle into the network through `node` (32-images §7.3): checked here first (the bundle check,
 * §2a), then in pieces from where the node stands, until it keeps it. Resolves once a node keeps it whole; rejects with a
 * `BlobRefused` (the node's reason, `check` for bytes that fail here, `stuck`, or `unreachable`) or the node's other
 * errors.
 */
export async function putBundle(node: NodeLike, zip: Uint8Array, o: BundlePutOptions = {}): Promise<BundlePut> {
  const problem = namedProblem("grain_bundle", zip);
  if (problem) throw new BlobRefused("check", problem);
  const hash = namedHash("grain_bundle", zip);
  const size = zip.length;
  if (o.upload && (o.upload.upload.bundle !== hash || o.upload.upload.size !== size)) {
    throw new BlobRefused("hash", "the statement names another bundle");
  }
  const upload = o.upload ? toHex(encodeSignedBundleUpload(o.upload)) : undefined;
  const pause = o.pause ?? defaultPause;
  const now = o.now ?? Date.now;
  const backoff = new Backoff({ pause, now, patience: o.patienceMs ?? PATIENCE_MS });
  const graceEnd = now() + (o.namedGraceMs ?? 0);
  let from = 0;
  let pieces = 0;
  let resumed = 0;
  // Every piece a few times over, and the waits besides: past that the upload is not moving.
  const rounds = 4 * Math.ceil(size / BLOB_PIECE) + 16;
  let calls = 0;
  for (;;) {
    if (calls++ > rounds + backoff.waits) throw new BlobRefused("stuck", `at byte ${from} of ${size}`);
    const piece = zip.subarray(from, Math.min(from + BLOB_PIECE, size));
    const params = { kind: "grain_bundle", hash, size, from, data: toBase64(piece), ...(upload ? { upload } : {}) };
    let answer: PutAnswer;
    try {
      answer = await nodeCall<PutAnswer>(node, "blob_put", params);
      pieces++;
    } catch (e) {
      const refused = refusalOf(e);
      if (refused?.reason === "offset" && refused.received !== null && refused.received <= size) {
        // Out of place: the node holds `received` bytes of it (0 at a node that never saw it). Go on from there.
        o.log?.("info", "blob_resume", { received: refused.received, size });
        from = refused.received;
        resumed++;
        continue;
      }
      if (refused && (TRANSIENT_BLOB_REASONS.has(refused.reason) || (refused.reason === "not_named" && now() < graceEnd))) {
        o.log?.("warn", "blob_wait", { reason: refused.reason });
        if (await backoff.wait()) continue;
        throw new BlobRefused(refused.reason, "the node did not take it in time");
      }
      if (refused) throw new BlobRefused(refused.reason);
      if (unreachable(e)) {
        o.log?.("warn", "blob_wait", { reason: "unreachable" });
        if (await backoff.wait()) continue;
        throw new BlobRefused("unreachable", (e as Error).message);
      }
      throw e;
    }
    if (answer.kept) {
      o.onProgress?.(size, size);
      o.log?.("info", "blob_kept", { bytes: size, pending: answer.pending === true, pieces, resumed });
      return { hash, size, pending: answer.pending === true, pieces, resumed, retries: backoff.waits };
    }
    const received = answer.received;
    if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 0 || received > size) {
      throw new BlobRefused("stuck", "the node's answer names no place in the bundle");
    }
    if (received > from) backoff.reset();
    from = received;
    o.onProgress?.(received, size);
  }
}

/**
 * Put a grain's icon into the network (32-images §7.1) once the registry names it: checked here first (§2), then whole.
 * `not_named` (the node a block behind the registry that answered) and the transient refusals are tried again.
 */
export async function putIcon(node: NodeLike, png: Uint8Array, o: PutOptions & { namedGraceMs?: number } = {}): Promise<{ hash: string }> {
  const problem = namedProblem("grain_icon", png);
  if (problem) throw new BlobRefused("check", problem);
  const pause = o.pause ?? defaultPause;
  const now = o.now ?? Date.now;
  const backoff = new Backoff({ pause, now, patience: o.patienceMs ?? PATIENCE_MS });
  const graceEnd = now() + (o.namedGraceMs ?? 0);
  for (;;) {
    try {
      const answer = await nodeCall<{ hash: string; kept: boolean }>(node, "blob_put", { kind: "grain_icon", data: toBase64(png) });
      o.log?.("info", "blob_kept", { bytes: png.length });
      return { hash: answer.hash };
    } catch (e) {
      const refused = refusalOf(e);
      const retry = refused
        ? TRANSIENT_BLOB_REASONS.has(refused.reason) || (refused.reason === "not_named" && now() < graceEnd)
        : unreachable(e);
      if (retry) {
        o.log?.("warn", "blob_wait", { reason: refused?.reason ?? "unreachable" });
        if (await backoff.wait()) continue;
        throw new BlobRefused(refused?.reason ?? "unreachable", "the node did not take it in time");
      }
      if (refused) throw new BlobRefused(refused.reason);
      throw e;
    }
  }
}

/** A blob as `blob_get` serves it: an image whole, a bundle a piece at a time. */
export interface BlobPiece {
  kind: NamedKind;
  hash: string;
  type: string;
  size: number;
  from: number;
  data: Uint8Array;
}

/**
 * `blob_get {kind, hash, from?, len?}` (32-images §8.1): the blob, or a bundle's piece, when the node holds it; else
 * null, with `fetching` true when the node has started to fetch it (ask again in about 2 s).
 */
export async function getBlob(node: NodeLike, kind: NamedKind, hash: string, piece: { from?: number; len?: number } = {}): Promise<{ blob: BlobPiece | null; fetching: boolean }> {
  const answer = await nodeCall<{ blob: { kind: NamedKind; hash: string; type: string; size: number; from: number; data: string } | null; fetching: boolean }>(
    node, "blob_get", { kind, hash, ...(piece.from !== undefined ? { from: piece.from } : {}), ...(piece.len !== undefined ? { len: piece.len } : {}) },
  );
  if (answer.blob === null) return { blob: null, fetching: answer.fetching === true };
  const b = answer.blob;
  return { blob: { kind: b.kind, hash: b.hash, type: b.type, size: b.size, from: b.from, data: fromBase64(b.data) }, fetching: false };
}

/** Whether the node holds a blob of `kind` and `hash`: `held`, `fetching` (it knows the blob named and fetches it), or
 *  `absent`. Reads at most one byte of a bundle. */
export async function blobHeld(node: NodeLike, kind: NamedKind, hash: string): Promise<"held" | "fetching" | "absent"> {
  const { blob, fetching } = await getBlob(node, kind, hash, kind === "grain_bundle" ? { from: 0, len: 1 } : {});
  return blob !== null ? "held" : fetching ? "fetching" : "absent";
}
