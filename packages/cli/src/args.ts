// The command line's words: which flags each command takes, which of them are switches (no value), and the help of one
// command cut from the whole. A flag a command does not take is refused, so a typo is never a silent default; `--help`
// never runs the command it asks about.

/** A misuse of the command line: the tool says how to use it and exits with 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Flags that take no value: whatever follows one is the next word, never its value. */
export const SWITCHES: ReadonlySet<string> = new Set(["chat", "wallet", "wait", "revoke-all", "public", "private", "clear", "offline"]);

/** A registry call signed with a key file: where it goes and how it is signed. */
const SIGNED = ["node", "key", "genesis", "fee", "valid-for"];
/** An owner's call: signed with a key file, or done in Saltix and waited for. */
const OWNER = [...SIGNED, "wallet", "wait", "timeout"];

/** The flags each command takes (`--help` aside, which every one does). */
export const FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: ["slug", "name", "chat"],
  dev: ["port", "manifest", "key"],
  lint: ["manifest", "key"],
  icon: [],
  sign: ["out", "manifest", "key"],
  bundle: ["sources", "start", "connect", "out", "dir", "manifest"],
  publish: [...OWNER, "manifest", "out"],
  retire: ["slug", ...SIGNED],
  show: ["slug", "node", "out"],
  "chat-spec": ["spec", "cert", "out", "manifest", "key"],
  cert: ["server", "server-key", "slug", "days", "out", "manifest", "key"],
  configure: ["slug", "server", "revoke-all", "category", ...OWNER],
  access: ["slug", "public", "private", "member", ...OWNER],
  rate: ["slug", "score", "review", ...SIGNED],
  bind: ["handle", "slug", "clear", ...OWNER],
  "app-key": ["file", "node", "offline", "slug", "server", "out"],
  sponsor: ["exchange", "amount", ...SIGNED],
};

export interface Parsed {
  /** `help` when the words ask for help (`help`, `--help`, `-h`, or none), `version` for `--version`. */
  command: string;
  /** With `help`: the command it is asked about, if any. */
  topic?: string;
  positional: string[];
  flags: Map<string, string | true>;
  /** Every value a repeated flag was given, in order. */
  all: (name: string) => string[];
}

const HELP_WORDS = new Set(["help", "--help", "-h"]);

/**
 * The words after `grain`: the command, its positional words and its flags, as `--name value`, `--name=value` or a
 * switch. Refuses a flag the command does not take, and a switch given a value with `=`. Asking for help anywhere asks
 * about the command and runs nothing.
 */
export function parse(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  const empty = { positional: [], flags: new Map<string, string | true>(), all: () => [] };
  if (first === undefined || HELP_WORDS.has(first)) {
    const topic = rest.find((a) => !a.startsWith("-"));
    return { command: "help", topic, ...empty };
  }
  if (first === "--version" || first === "-V" || first === "version") return { command: "version", ...empty };
  if (rest.some((a) => a === "--help" || a === "-h")) return { command: "help", topic: first, ...empty };
  const takes = FLAGS[first];
  if (takes === undefined) throw new UsageError(`no command "${first}": ${Object.keys(FLAGS).join(", ")} (grain help says what each does)`);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!takes.includes(name)) {
      const known = takes.length === 0 ? "no flags" : takes.map((f) => `--${f}`).join(", ");
      throw new UsageError(`grain ${first} takes no --${name}; it takes ${known} (grain ${first} --help)`);
    }
    let value: string | true;
    if (SWITCHES.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} is a switch: it takes no value`);
      value = true;
    } else if (eq >= 0) {
      value = a.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      value = next !== undefined && !next.startsWith("--") ? next : true;
      if (value !== true) i++;
    }
    flags.set(name, value);
    if (value !== true) repeated.set(name, [...(repeated.get(name) ?? []), value]);
  }
  return { command: first, positional, flags, all: (name) => repeated.get(name) ?? [] };
}

/** Lines of `help` that start a command's entry: `  grain <command>…`. */
const ENTRY = /^ {2}grain ([a-z-]+)/;

/**
 * The part of the whole `help` about `command`: its entries (each with the lines that go on under it), then the notes
 * (the lines that start at the margin's second column) that concern it: the owner's calls' note for those calls, and a
 * note on flags when it names one the command takes. Null for a command it does not name.
 */
export function helpFor(help: string, command: string): string | null {
  const lines = help.split("\n");
  const out = entriesOf(help, command);
  if (out.length === 0) return null;
  const takes = FLAGS[command] ?? [];
  const concerns = (line: string) => {
    if (OWNER_NOTE.test(line)) return OWNER_CALLS.has(command);
    const named = flagsNamed(line);
    return named.length === 0 || named.some((f) => takes.includes(f));
  };
  const notes = lines.filter((line) => /^ {2}\S/.test(line) && !ENTRY.test(line) && concerns(line));
  return [lines[0]!, "", ...out, ...(notes.length > 0 ? ["", ...notes] : [])].join("\n") + "\n";
}

/** The lines of `help` that are `command`'s entries, each with the lines that go on under it. */
export function entriesOf(help: string, command: string): string[] {
  const out: string[] = [];
  let inEntry = false;
  for (const line of help.split("\n")) {
    const entry = ENTRY.exec(line);
    if (entry) inEntry = entry[1] === command;
    else if (!/^ {5,}\S/.test(line)) inEntry = false;
    if (inEntry) out.push(line);
  }
  return out;
}

/** The note about the owner's calls, and the commands it concerns. */
const OWNER_NOTE = /owner's calls|says what to do in the owner's Saltix/;
const OWNER_CALLS = new Set(["publish", "configure", "access", "bind"]);

/** Every `--flag` the text names. */
export const flagsNamed = (text: string): string[] => [...new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!))];
