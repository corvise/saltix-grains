// The protocol version a call signed now meets (Saltix 23-upgrades §6, §6a): the network's version from node_status,
// a node left behind included; the next version's first slot; and each call's window, cut before a version that
// refuses its form.
import test from "node:test";
import assert from "node:assert/strict";
import { callVersions } from "@saltix/grain-server";
import { SWITCH_MARGIN, VersionError, networkVersion, nextSwitch, protocolOf, windowFor } from "../dist/versions.js";

const sealed = (sources) => ({ register: { manifest: { slug: "dice", entry: { sealed: { bundle: "11".repeat(32), size: 10, sources, start: "index.html", connect: [] } } }, signature: "" } });
const hosted = { update: { manifest: { slug: "dice", entry: { hosted: { url: "https://dice.example" } } }, signature: "" } };

test("the network's version: the node's schedule, or the later one a node left behind saw; 1 from a node before versions", () => {
  assert.equal(protocolOf({}), 1);
  assert.equal(networkVersion({}), 1);
  assert.equal(networkVersion({ protocol: { version: 2 } }), 2);
  assert.equal(networkVersion({ protocol: { version: 1, outdated: { version: 3 } } }), 3);
  assert.equal(networkVersion({ protocol: { version: 2, outdated: { version: 1 } } }), 2, "never lower than the node's own");
  assert.equal(networkVersion({ protocol: { version: "2" } }), 1, "only a number counts");
  assert.equal(networkVersion({ protocol: { version: -4 } }), 1);
});

test("the next version's first slot is its epoch times the epoch's slots, known only when the node names both", () => {
  const status = (next, epochSlots = 2400) => ({ protocol: { version: 1, next }, epoch_slots: epochSlots });
  assert.deepEqual(nextSwitch(status({ version: 2, epoch: 36 })), { version: 2, slot: 86_400 });
  assert.equal(nextSwitch(status(null)), null);
  assert.equal(nextSwitch(status({ version: 2, epoch: 36 }, null)), null, "no epoch length, no switch to place");
  assert.equal(nextSwitch(status({ version: 1, epoch: 36 })), null, "not a later version");
  assert.equal(nextSwitch(status({ version: 2, epoch: Number.MAX_SAFE_INTEGER })), null, "past what a slot can be");
});

test("each call's versions: ConfigureGrain's two forms, and a sealed manifest without a source from version 2", () => {
  assert.deepEqual(callVersions({ configure: { slug: "dice", servers: [], category: 0 } }), { since: 1, until: 2 });
  assert.deepEqual(callVersions({ configureProven: { slug: "dice", servers: [], category: 0 } }), { since: 2, until: null });
  assert.deepEqual(callVersions(sealed([])), { since: 2, until: null });
  assert.deepEqual(callVersions(sealed(["https://dice.example/b.zip"])), { since: 1, until: null });
  assert.deepEqual(callVersions(hosted), { since: 1, until: null });
  assert.deepEqual(callVersions({ retire: "dice" }), { since: 1, until: null });
});

test("a call's window: whole, cut at the switch that retires its form, refused just before it or in a version that does not take it", () => {
  const v1 = { configure: { slug: "dice", servers: [], category: 0 } };
  const at = (slot, next = { version: 2, epoch: 10 }) => ({ slot, epoch_slots: 100, protocol: { version: 1, next } });
  assert.equal(windowFor(v1, at(100), 600), 700);
  assert.equal(windowFor(v1, at(500), 600), 999);
  assert.equal(windowFor(v1, at(1000 - SWITCH_MARGIN), 600), 999, "the last slot it is still signed in");
  assert.throws(() => windowFor(v1, at(1000 - SWITCH_MARGIN + 1), 600), VersionError);
  assert.equal(windowFor(v1, at(500, null), 600), 1100, "no switch scheduled");
  assert.equal(windowFor(v1, at(500, { version: 3, epoch: 10 }), 600), 999, "a later version refuses it too");
  // A form no version retires keeps its whole window across the switch.
  assert.equal(windowFor(sealed(["https://dice.example/b.zip"]), at(500), 600), 1100);
  assert.throws(() => windowFor(sealed([]), at(500), 600), /this call is protocol version 2's/);
  assert.equal(windowFor(sealed([]), { slot: 500, protocol: { version: 2 } }, 600), 1100);
  assert.throws(() => windowFor(v1, { slot: 500, protocol: { version: 2 } }, 600), /no longer takes this form/);
});
