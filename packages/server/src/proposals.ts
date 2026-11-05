// The proposal a project's `grain publish` leaves for the app's running server (Saltix 24-app-studio §4, *Awaiting
// you*; 22-grain-chats §4): `.grain/proposal.json`, the manifest to publish next. The server that serves the app
// (`ChatServer` started with `proposals`) reads it when it starts and whenever it changes, proposes it to the team in the
// app's console with a `Publish` card — the owner approves it in Saltix under **Awaiting you**, no QR code to scan, which
// is how a developer's change reaches an owner who is somebody else — and writes back what became of it, which `grain
// publish` reads to say so. The version in the file is the developer's proposal: the server raises it to the registry's
// + 1 where the registry moved on meanwhile (the owner's own change of the icon or the details makes a version too), and
// the wallet that signs takes the content and sets the number (12-grains §10). Nothing secret is in the file.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { toHex } from "./bytes.js";
import { type Manifest, encodeManifest, manifestProblem } from "./manifest.js";
import { UNOWNED } from "./publish.js";

/** Where a project's proposal stands, under the project directory. */
export const PROPOSAL_FILE = ".grain/proposal.json";
/** A proposal the owner's console did not get is proposed again this often, while the file stands. */
export const PROPOSAL_RETRY_MS = 60_000;
/** A proposal older than this is left alone: its `grain publish` is long over, and the registry says what became of it. */
export const PROPOSAL_LIFE_MS = 24 * 3_600_000;

/** What `grain publish` wrote, and what the server did with it. */
export interface Proposal {
  slug: string;
  /** The version proposed: grain.json's, or the one the server raised it to. */
  version: number;
  /** The manifest to publish, as `grain publish` sends it (the owner and owner key the wallet's to fill in). */
  manifest: Manifest;
  /** Its publishing link, for a wallet without the console (the QR code's text). */
  link?: string;
  /** When `grain publish` wrote it, ISO 8601. */
  at: string;
  /** What wrote it. */
  from?: string;
  /** When the server last proposed it in the console, and what it proposed: the version and the content's hash. */
  proposed_at?: string | null;
  proposed_version?: number | null;
  proposed_hash?: string | null;
  /** Whether the owner's console got it (the one who approves it); false until the owner's wallet reached the app. */
  owner?: boolean | null;
  /** How many of the team got it, and how many could not be reached. */
  sent?: number | null;
  unreachable?: number | null;
  /** When the registry was seen holding this content, and as which version. */
  landed_at?: string | null;
  landed_version?: number | null;
  /** Why the last attempt failed, in words; null once one went. */
  error?: string | null;
}

/** The hash of a manifest's content, but for its version and owner: what a proposal is, whatever number it gets. */
export function proposalHash(m: Manifest): string {
  const plain: Manifest = { ...m, ...UNOWNED, version: 1 };
  return toHex(sha256(encodeManifest(plain)));
}

/** The proposal at `path`, or null where there is none or it does not read as one (a broken file is nobody's order). */
export function readProposal(path: string): Proposal | null {
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Proposal;
    if (typeof p !== "object" || p === null || typeof p.slug !== "string" || typeof p.version !== "number" || typeof p.at !== "string") return null;
    if (typeof p.manifest !== "object" || p.manifest === null || manifestProblem(p.manifest) !== null) return null;
    return p;
  } catch {
    return null;
  }
}

/** Write `p` at `path`, whole or not at all (a reader never sees half a file). */
export function writeProposal(path: string, p: Proposal): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, JSON.stringify(p, null, 2) + "\n");
  renameSync(next, path);
}

/** Remove the proposal at `path`, if any. */
export function removeProposal(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Whether `p` is still a live order: not landed, and written within its life. */
export function proposalStands(p: Proposal, now: number): boolean {
  if (p.landed_at) return false;
  const at = Date.parse(p.at);
  return Number.isFinite(at) && now - at < PROPOSAL_LIFE_MS;
}
