// A long wait, said while it lasts. A registry call signed here lands in about 1.5 to 2.5 minutes on the test network (a
// shard block takes it, then the beacon chain's registry applies it once the shard block is linked there), a first
// publish with a key file in up to about 6; the owner's Saltix takes as long as the owner does. A command that waits says
// what it waits for, where it stands and for how long: on a terminal one line rewritten in place; elsewhere (an agent's
// tool, a pipe, a log file) a line whenever the stage changes and every 15 seconds besides, so that a reader never meets
// minutes of silence and can tell a slow network from a stuck command.

/** Off a terminal, a waiting command says where it stands at least this often. */
export const QUIET_MS = 15_000;

/** What a registry call takes to land on the test network, in words, for the lines that start a wait. */
export const LANDS_IN = "usually 1.5 to 2.5 minutes on the test network";

export interface WaitOut {
  /** Whether the output is a terminal, where one line can be rewritten in place. */
  tty: boolean;
  print: (line: string) => void;
  /** Writes a line that replaces the one before it on a terminal (without ending it). */
  progress?: (line: string) => void;
  /** Tests: the clock, and how often a line is printed off a terminal. */
  now?: () => number;
  every?: number;
}

/** Milliseconds as minutes and seconds, `1:05`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One wait: `at(stage)` as often as the waiting code looks (every poll), `done()` once it is over. */
export class Waiting {
  private readonly started: number;
  private printedAt = -Infinity;
  private stage: string | null = null;
  private rewritten = false;

  constructor(private readonly out: WaitOut, private readonly what: string) {
    this.started = this.now();
  }

  private now(): number {
    return (this.out.now ?? Date.now)();
  }

  /** How long it has waited, in ms. */
  get ms(): number {
    return this.now() - this.started;
  }

  /** Where the wait stands: rewritten in place on a terminal; printed off one when it changed or every 15 seconds. */
  at(stage: string): void {
    const line = `  ${this.what}: ${stage} (${elapsed(this.ms)})`;
    if (this.out.tty && this.out.progress) {
      this.out.progress(line);
      this.rewritten = true;
    } else if (stage !== this.stage || this.now() - this.printedAt >= (this.out.every ?? QUIET_MS)) {
      this.out.print(line);
      this.printedAt = this.now();
    }
    this.stage = stage;
  }

  /** The wait is over: a terminal's rewritten line is ended, so what follows starts on a line of its own. */
  done(): void {
    if (this.rewritten) this.out.print("");
    this.rewritten = false;
  }
}

/** A terminal's line rewritten in place: back to its start, the text, the rest of the old line cleared. */
export const rewriteLine = (write: (text: string) => void) => (line: string): void => write(`\r${line}\x1b[K`);
