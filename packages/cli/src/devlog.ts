// The developer experience's log: every command run in an app's project appends its steps to `.grain/log.jsonl`, one
// JSON line each — the command, the step, its outcome, a stable reason code, the milliseconds since the command started,
// the network's kind — so that what went wrong, and how long each step took, can be read back and improved
// (docs/devex.md, "The steps' log"). It never holds a key, an address, a slug, a path, an argument or anything a user
// typed: steps and reasons are codes, and anything else is refused before it is written. It stays on the computer;
// share it when reporting a problem. `SALTIX_GRAIN_LOG=off` turns it off.
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Where the command line keeps a project's own state: the log, a key not paired yet, the pairing page. */
export const GRAIN_DIR = ".grain";
export const LOG_FILE = join(GRAIN_DIR, "log.jsonl");
/** Past this size the log moves to `log.1.jsonl` (the one before it is dropped). */
export const MAX_LOG_BYTES = 1 << 20;

/** What became of a step. */
export type Outcome = "ok" | "waiting" | "refused" | "failed" | "timeout";

/** A step's or a reason's code: lower case, digits and `_`, at most 48 characters. Nothing else is ever written. */
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const code = (text: string | undefined): string | undefined => (text === undefined ? undefined : CODE.test(text) ? text : "other");
const NETWORKS = new Set(["mainnet", "testnet", "devnet"]);

/** Whether `dir` is an app's project, where a command keeps its log: it has a manifest, a chat spec, a key or `.grain`. */
export const isProject = (dir: string): boolean =>
  ["grain.json", "chat.json", "app.key", GRAIN_DIR].some((name) => existsSync(join(dir, name)));

/** `.grain/` in `dir`, made owner-only when it is not there. */
export function grainDir(dir: string): string {
  const path = join(dir, GRAIN_DIR);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  return path;
}

/** One run of a command, logging its steps in `dir` when it is a project. */
export class DevLog {
  private readonly started = Date.now();
  private readonly run = randomBytes(4).toString("hex");
  private network: string | undefined;

  constructor(
    private dir: string | null,
    private readonly command: string,
    private readonly tool: string,
    private readonly enabled = process.env.SALTIX_GRAIN_LOG !== "off",
  ) {}

  /** Log from now on in `dir` (a project a command just made, or one it now knows it is in). */
  at(dir: string): void {
    this.dir = dir;
  }

  /** The network's kind the command reached, for every later line. */
  onNetwork(network: string): void {
    if (NETWORKS.has(network)) this.network = network;
  }

  /** Append a step: `step` and `reason` are codes; anything that is not one is written as `other`. */
  step(step: string, outcome: Outcome, reason?: string): void {
    if (!this.enabled || this.dir === null || !isProject(this.dir)) return;
    const line = {
      at: new Date().toISOString(),
      tool: this.tool,
      run: this.run,
      command: code(this.command),
      step: code(step),
      outcome,
      ...(reason !== undefined ? { reason: code(reason) } : {}),
      ms: Date.now() - this.started,
      ...(this.network ? { network: this.network } : {}),
    };
    try {
      const path = join(grainDir(this.dir), "log.jsonl");
      if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, join(this.dir, GRAIN_DIR, "log.1.jsonl"));
      appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // The log never stops a command.
    }
  }

  /** The command's last line: its exit status and, for a failure, why. */
  end(exit: number, reason?: string): void {
    this.step("end", exit === 0 ? "ok" : "failed", exit === 0 ? undefined : reason ?? `exit_${exit}`);
  }
}

/** A stable reason code for an error a command ended with: its `problem` or `code` when it has one, else its kind. */
export function reasonOf(error: unknown): string {
  const e = error as { name?: string; problem?: string; code?: string | number; message?: string; step?: string; reason?: string };
  if (e?.name === "UsageError") return "usage";
  if (e?.name === "AppKeyError" && e.problem) return `app_key_${e.problem}`;
  if (e?.name === "PairingError" && e.problem) return `pairing_${e.problem}`;
  if ((e?.name === "ChatSetupError" || e?.name === "ChatKeyNotRegistered") && typeof e.code === "string") return e.code;
  if (e?.name === "PublishError" && e.step && e.reason) return `${e.step}_${e.reason}`;
  if (e?.name === "RpcError") return "node_refused";
  if (typeof e?.message === "string" && /no relay answered|no relay took|ECONNREFUSED|ENOTFOUND|fetch failed/.test(e.message)) return "network_unreachable";
  if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) return `fs_${e.code.toLowerCase()}`;
  return "error";
}
