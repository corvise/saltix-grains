// A long wait said while it lasts (`wait.ts`): on a terminal one line rewritten in place, its end closed with a line of
// its own; off a terminal (an agent's tool, a pipe) a line whenever the stage changes and every 15 seconds besides,
// never a line a poll.
import test from "node:test";
import assert from "node:assert/strict";
import { QUIET_MS, Waiting, elapsed, rewriteLine } from "../dist/wait.js";

test("off a terminal: a line when the stage changes and every 15 seconds, the time waited in each", () => {
  let now = 1_000_000;
  const printed = [];
  const w = new Waiting({ tty: false, print: (l) => printed.push(l), now: () => now }, "register dice v1");
  w.at("in the pool");
  for (let i = 0; i < 6; i++) {
    now += 2_000;
    w.at("in the pool");
  }
  assert.deepEqual(printed, ["  register dice v1: in the pool (0:00)"], "no line a poll");
  now += 3_000;
  w.at("in the pool");
  assert.deepEqual(printed.at(-1), "  register dice v1: in the pool (0:15)", "every 15 seconds");
  now += 1_000;
  w.at("in a shard block");
  assert.deepEqual(printed.at(-1), "  register dice v1: in a shard block (0:16)", "and when the stage changes");
  now += 65_000;
  w.at("in a shard block");
  assert.equal(printed.at(-1), "  register dice v1: in a shard block (1:21)");
  w.done();
  assert.equal(printed.length, 4, "nothing more off a terminal");
  assert.equal(QUIET_MS, 15_000);
});

test("on a terminal: one line rewritten in place at every look, ended once the wait is over", () => {
  let now = 0;
  const printed = [];
  const rewritten = [];
  const w = new Waiting({ tty: true, print: (l) => printed.push(l), progress: (l) => rewritten.push(l), now: () => now }, "waiting");
  for (let i = 0; i < 3; i++) {
    w.at("in the pool");
    now += 1_000;
  }
  assert.deepEqual(rewritten, ["  waiting: in the pool (0:00)", "  waiting: in the pool (0:01)", "  waiting: in the pool (0:02)"]);
  assert.deepEqual(printed, []);
  w.done();
  assert.deepEqual(printed, [""], "the line ended, so what follows starts a line of its own");
  w.done();
  assert.deepEqual(printed, [""], "once");
  // A terminal's line: back to its start, the text, the rest of the old line cleared.
  const out = [];
  rewriteLine((t) => out.push(t))("  waiting: x");
  assert.deepEqual(out, ["\r  waiting: x\x1b[K"]);
  assert.equal(elapsed(0), "0:00");
  assert.equal(elapsed(59_999), "0:59");
  assert.equal(elapsed(125_000), "2:05");
});
