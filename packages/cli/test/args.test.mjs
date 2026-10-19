// The command line's words: help that never runs a command, switches that never swallow the next word, flags as
// `--name value` or `--name=value`, and a flag or a command it does not know refused, never taken as a silent default.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FLAGS, SWITCHES, UsageError, entriesOf, flagsNamed, helpFor, notesOf, parse } from "../dist/args.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
/** `grain …` in `cwd`, killed after 10 s so that a command that serves forever fails the test instead of hanging it. */
const grain = (args, cwd = tmpdir()) => {
  const r = spawnSync("node", [main, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
};
const HELP = grain(["help"]).stdout;

test("asking for help runs nothing: no words, help, --help and -h anywhere", () => {
  assert.equal(parse([]).command, "help");
  assert.deepEqual([parse(["help"]).command, parse(["help"]).topic], ["help", undefined]);
  assert.deepEqual([parse(["--help"]).command, parse(["-h", "init"]).topic], ["help", "init"]);
  for (const words of [["init", "--help"], ["init", "dice", "-h"], ["publish", "--node", "http://n", "--help"], ["help", "publish"]]) {
    const p = parse(words);
    assert.equal(p.command, "help", words.join(" "));
    assert.equal(p.topic, words[0] === "help" ? words[1] : words[0]);
  }
  assert.equal(parse(["--version"]).command, "version");
});

test("a switch never takes the next word, and a value comes either way", () => {
  const p = parse(["init", "--chat", "coach", "--name", "Coach"]);
  assert.deepEqual(p.positional, ["coach"], "init --chat coach makes coach, a chat-only grain");
  assert.equal(p.flags.get("chat"), true);
  assert.equal(p.flags.get("name"), "Coach");
  assert.equal(parse(["show", "--slug=dice", "--node=http://127.0.0.1:30334/?a=b"]).flags.get("node"), "http://127.0.0.1:30334/?a=b");
  assert.equal(parse(["show", "--slug="]).flags.get("slug"), "", "an empty value is a value");
  assert.equal(parse(["show", "--slug"]).flags.get("slug"), true, "no value: the command says it needs one");
  const c = parse(["configure", "--server", "a.key", "--server=b.key", "--slug", "dice"]);
  assert.deepEqual(c.all("server"), ["a.key", "b.key"]);
  assert.deepEqual(c.all("node"), []);
  for (const s of SWITCHES) assert.ok(Object.values(FLAGS).some((takes) => takes.includes(s)), `${s} is some command's`);
});

test("a flag a command does not take, a switch given a value and an unknown command are refused", () => {
  assert.throws(() => parse(["lint", "--manifst", "x.json"]), (e) => e instanceof UsageError && /takes no --manifst; it takes --manifest, --key/.test(e.message));
  assert.throws(() => parse(["icon", "--key", "x"]), /takes no --key; it takes --out, --fit, --background, --preview, --fix, --monogram, --manifest/);
  assert.throws(() => parse(["version-of-nothing"]), /no command/);
  assert.throws(() => parse(["init", "--chat=yes"]), (e) => e instanceof UsageError && /switch/.test(e.message));
  assert.throws(() => parse(["frob"]), (e) => e instanceof UsageError && /no command "frob"/.test(e.message));
  // Each command's own flags: the owner's calls take what a signed call takes, and how to wait for Saltix.
  for (const call of ["configure", "access", "bind", "publish"]) {
    for (const f of ["node", "key", "wallet", "wait", "timeout", "genesis", "fee", "valid-for"]) assert.ok(FLAGS[call].includes(f), `${call} --${f}`);
  }
  assert.throws(() => parse(["show", "--key", "owner.key"]), /takes no --key/, "show signs nothing");
});

test("the help names every command, and every flag a command's help names is one it takes", () => {
  for (const [command, takes] of Object.entries(FLAGS)) {
    const entries = entriesOf(HELP, command);
    assert.ok(entries.length > 0, `the help names grain ${command}`);
    for (const f of flagsNamed(entries.join("\n"))) assert.ok(takes.includes(f), `grain ${command}'s help names --${f}, which it does not take`);
    const part = helpFor(HELP, command);
    assert.ok(part.includes(`grain ${command}`));
    for (const other of Object.keys(FLAGS)) {
      if (other !== command && !other.startsWith(command) && !command.startsWith(other)) assert.ok(!part.includes(`  grain ${other} `), `${command}'s help is its own`);
    }
  }
  assert.match(helpFor(HELP, "publish"), /owner's calls/);
  assert.doesNotMatch(helpFor(HELP, "lint"), /owner's calls/);
  assert.doesNotMatch(helpFor(HELP, "show"), /--manifest F/, "a note on flags the command does not take is left out");
  assert.equal(helpFor(HELP, "frob"), null);
});

test("one command's help keeps each note whole: never a sentence cut from a note it leaves out", () => {
  const notes = notesOf(HELP);
  assert.ok(notes.length >= 8, notes.join("\n---\n"));
  // The owner's calls' note is one paragraph of several lines, and ends a sentence.
  const owner = notes.find((n) => /owner's calls/.test(n));
  assert.ok(owner.split("\n").length >= 4 && /\.$/.test(owner), owner);
  for (const command of Object.keys(FLAGS)) {
    const part = helpFor(HELP, command);
    const tail = part.slice(part.indexOf("\n\n", part.indexOf(`grain ${command}`)) + 2);
    // Every note line printed belongs to a note printed whole.
    const shown = notes.filter((n) => part.includes(n));
    for (const line of tail.split("\n").filter((l) => /^ {2}\S/.test(l) || /^ {4}\S/.test(l))) {
      if (/^ {2}grain /.test(line)) continue;
      assert.ok(shown.some((n) => n.split("\n").includes(line)), `grain help ${command} prints "${line}" outside a whole note`);
    }
  }
  // What the agent met: grain help init printed the owner's note from its middle on.
  const init = helpFor(HELP, "init");
  assert.doesNotMatch(init, /with a key file returns once it landed|built again once that landed/);
  assert.match(helpFor(HELP, "profile"), /The owner's calls[\s\S]*--no-wait returns once the pool took it\./);
});

test("--help on any command prints its help, exits 0 and leaves the directory as it was", () => {
  for (const command of Object.keys(FLAGS)) {
    const dir = scratch("grain-help-");
    const r = grain([command, "--help"], dir);
    assert.equal(r.signal, null, `grain ${command} --help returned`);
    assert.equal(r.code, 0, `${command}: ${r.stderr}`);
    assert.ok(r.stdout.includes(`grain ${command}`), command);
    assert.deepEqual(readdirSync(dir), [], `grain ${command} --help made nothing`);
  }
  assert.equal(grain(["help", "init"]).stdout, grain(["init", "-h"]).stdout);
});

test("misuse exits 2 and says what to do; --version names the tool's version", () => {
  const dir = scratch("grain-misuse-");
  const typo = grain(["init", "dice", "--nmae", "Dice"], dir);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /grain init takes no --nmae/);
  assert.deepEqual(readdirSync(dir), [], "a refused command made nothing");
  const unknown = grain(["frob"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no command "frob"/);
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(grain(["--version"]).stdout.trim(), `grain ${version} (@saltix/grain-cli)`);
  const chat = grain(["init", "--chat", "coach"], dir);
  assert.equal(chat.code, 0, chat.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "coach", "grain.json"), "utf8")).entry, { chat: {} });
});
