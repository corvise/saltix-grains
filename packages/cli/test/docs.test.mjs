// What the README says of the tools holds: every command of the help is in its table, and the development server
// reads a node where a node listens by default.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const help = spawnSync("node", [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "help"], { encoding: "utf8" }).stdout;

test("the README shows every command the help lists", () => {
  const commands = [...new Set([...help.matchAll(/^ {2}grain ([a-z][a-z-]*)/gm)].map((m) => m[1]))].filter((c) => c !== "help");
  assert.ok(commands.length >= 15, commands.join(" "));
  const readme = read("README.md");
  for (const c of commands) assert.ok(readme.includes(`grain ${c} `), `the README never shows grain ${c}`);
});

test("npm run dev reads a node at a node's own default port, as the README says", () => {
  // 08-node §5: `--rpc` listens on 127.0.0.1:30334 unless told otherwise.
  const dev = /process\.env\.NODE_RPC \?\? "([^"]+)"/.exec(read("scripts/dev.mjs"))[1];
  assert.equal(dev, "http://127.0.0.1:30334");
  assert.match(read("README.md"), /`NODE_RPC` \(default `http:\/\/127\.0\.0\.1:30334`/);
  for (const doc of ["README.md", "docs/first-app.md", "docs/chats.md", "scripts/dev.mjs"]) {
    assert.doesNotMatch(read(doc), /30734/, `${doc}: no node listens on 30734`);
  }
});

test("examples name the test network by its kind", () => {
  for (const doc of ["README.md", "docs/chats.md", "docs/first-app.md"]) {
    assert.doesNotMatch(read(doc), /network: "testnet"/, `${doc}: Saltix's test network is of the devnet kind`);
  }
});

test("a Connect grant is for showing an account, and nothing invites a server to take it as a login", () => {
  // Whoever holds a grant's bytes (anyone the page leaked them to, a relayed QR's other end) holds all it proves: it
  // carries no server's challenge, so a server that took it would sign in whoever copied it (19-connect §5, §8).
  const store = read("packages/connect/src/store.ts");
  assert.doesNotMatch(store, /server that checks it/i);
  assert.match(store, /for display only/i);
  const doc = read("docs/connect.md");
  assert.match(doc, /^## .*never a server's login/m);
  assert.match(doc, /bearer/i);
  assert.match(doc, /nonce/i, "a server's own login needs a challenge of its own");
  assert.match(read("AGENTS.md"), /Connect\s+grant[^.]*display only/i);
});

test("the pairing command alone leads an agent to the SDK, how it works first, and the brief Saltix copies never holds a key", () => {
  // The README's first line is what an agent handed only the command finds first: where to start, and what to show; a
  // developer key made before pairing is named too, and where it goes.
  const readme = read("README.md").split("\n").slice(0, 6).join("\n").replace(/\s+/g, " ");
  assert.match(readme, /Got a command starting with `grain pair --app`\? It is the pairing command from a Saltix mini-app's page — start with \[docs\/how-it-works\.md\]\(docs\/how-it-works\.md\) and \[AGENTS\.md\]/);
  assert.match(readme, /AGENTS\.md#start-here-saltixs-brief-or-the-pairing-command/);
  assert.match(readme, /keep the key in `app\.key`, never in a chat or a commit, and pair a server in its place/);

  // AGENTS.md sends a reader to how-it-works.md before any other page, then its first steps: the decision table, the
  // key's public parts only, the app's own project, grain status first, the person saves the key, one app one key.
  const agents = read("AGENTS.md");
  const firstLink = /\]\((docs\/[^)#]+)/.exec(agents)[1];
  assert.equal(firstLink, "docs/how-it-works.md", "how it works is the first page AGENTS.md links");
  const steps = agents.slice(agents.indexOf("## Start here: Saltix's brief, or the pairing command"), agents.indexOf("## Building an app: safe by default"))
    .replace(/\s+/g, " ");
  for (const words of ["[Do I need a server?](docs/how-it-works.md#do-i-need-a-server)", "`npx grain init ../<slug> --chat --slug <slug>`",
      "**Pair it, every session from `grain status`**", "`npx grain pair`", "`.grain/pair.html`", "the 6-digit code, and wait",
      "**Add this server**", "`npx grain doctor`", "**Never ask the person to paste, type or send a key.**",
      "**Never ask the person for a key, a token or an address they did not give you**", "`--app`, `--owner`, `--genesis`",
      "**A developer key is retired.**", "never print, repeat, log or quote it",
      "`npx grain app-key --file app.key --offline`", "**One app, one key, one program.**",
      "Never run the SDK's example (`npm run example`) or any other program with the key of an app that already has a program",
      "never reuse another app's key or slug", "`(umask 077 && cat > app.key)`", "**Replace key**", "`npm start`",
      "[the lifecycle](docs/how-it-works.md#the-lifecycle-as-one-checklist)"]) {
    assert.ok(steps.includes(words), `AGENTS.md's first steps: ${words}`);
  }
  assert.ok(steps.indexOf("`grain status`") < steps.indexOf("`npx grain pair`") && steps.indexOf("`npx grain pair`") < steps.indexOf("`npx grain doctor`"),
    "status, then pair, then doctor");

  // The brief, as Saltix copies it (the wallet's own test holds its text to this one): placeholders, no key.
  const doc = read("docs/first-app.md");
  const section = doc.slice(doc.indexOf("## Building with a coding agent"), doc.indexOf("## When something fails"));
  const brief = /```text\n([\s\S]*?)\n```/.exec(section)[1];
  assert.match(brief, /^Brief for a coding agent: build the Saltix mini-app "\{name\}" \(\{slug\}\)\.$/m);
  assert.match(brief, /^Answer me in English: it is the language of my Saltix app\.$/m);
  assert.ok(brief.includes("Read first: docs/how-it-works.md"), "how it works first");
  assert.ok(brief.includes("A page alone needs no server.") && brief.includes("no domain, open port or certificate"));
  assert.ok(brief.includes("  git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains"));
  assert.ok(brief.includes("  npx grain init ../{slug} --chat --slug {slug} && cd ../{slug} && npm install"), "the app's own project");
  assert.ok(brief.includes("no key ever passes through this chat") && brief.includes("Never ask me for a key, a token or an address I did not give you"));
  assert.ok(brief.includes("Then `npx grain pair --app {slug} --owner {owner} --genesis {genesis}`"), "the command's three facts, as placeholders");
  assert.ok(brief.includes("- Owner: {owner}"), "the owner's address is in the brief");
  // Pairing (24-app-studio §3a): grain status, then grain pair, whose QR code (or .grain/pair.html) and 6-digit code the
  // agent shows and waits, then grain doctor; a developer key only for a host where no command runs.
  assert.ok(brief.indexOf("Run `npx grain status` first") < brief.indexOf("Then `npx grain pair`"));
  assert.ok(brief.indexOf("Then `npx grain pair`") < brief.indexOf("Then `npx grain doctor`"));
  assert.ok(brief.includes("(also in .grain/pair.html) and a six-digit code") && brief.includes("Show me the QR code and the code, then wait"));
  assert.ok(brief.includes("a developer key (saltix-app:1:…) is retired"));
  assert.ok(brief.includes("One app, one key, one program") && brief.includes("Never run the SDK's example"));
  assert.doesNotMatch(brief, /npm run example/, "never the example: its spec would outrank the project's");
  assert.doesNotMatch(brief, /saltix-app:1:[a-z]+:/, "no key, not even its start");
  assert.doesNotMatch(brief, /[0-9a-f]{32}/, "nothing as long as a secret");
  assert.ok(brief.split("\n").length <= 25, "short enough to paste");
  for (const path of ["docs/how-it-works.md", "AGENTS.md", "docs/first-app.md", "docs/agents/app.md"]) {
    assert.ok(existsSync(new URL(path, root)), `the brief names ${path}, which the SDK has`);
  }
  assert.ok(doc.includes("## When it does not start"), "the heading the brief sends a reader to");
  assert.ok(section.includes("**Replace key**"), "and what to do with a key that leaked");
});

test("how-it-works.md: the pieces, whether an app needs a server, and the lifecycle as one checklist", () => {
  const page = read("docs/how-it-works.md");
  for (const heading of ["## The pieces", "## Do I need a server?", "## The lifecycle, as one checklist", "## Publish a page", "## Run the program"]) {
    assert.ok(page.includes(`\n${heading}\n`), heading);
  }
  const flat = page.replace(/\s+/g, " ");
  // The program talks only outbound, and the owner's phone signs what the registry holds.
  assert.ok(flat.includes("**connects out** to the network's public relays"));
  assert.ok(flat.includes("**no domain, no open port and no certificate**"));
  assert.ok(flat.includes("**The owner's phone signs everything the registry holds of the app.**"));
  // The table: what needs no program, what needs one.
  const table = page.slice(page.indexOf("## Do I need a server?"), page.indexOf("## The lifecycle"));
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| The app") && !l.startsWith("|---"));
  const answers = rows.map((r) => r.split("|")[2].trim());
  assert.deepEqual(answers.filter((a) => a === "**No**").length, 2, "a page alone, and users together live");
  assert.ok(answers.filter((a) => a === "**Yes**").length >= 5, answers.join(" "));
  assert.ok(rows[0].includes("a page that works on its own") && rows[0].includes("`grain.storage`"));
  for (const need of ["is a chat", "takes payments", "keeps state shared between users", "notifies users while the app is closed"]) {
    assert.ok(rows.some((r) => r.includes(need) && r.includes("**Yes**")), need);
  }
  // The checklist: eight steps in the order a project goes through them.
  const list = page.slice(page.indexOf("## The lifecycle"), page.indexOf("## Publish a page"));
  const steps = [...list.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(steps.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(steps.map(([, t]) => t), ["One app, one project, one key.", "Set up and pair.", "Build.",
    "Keep the standards.", "Try it.", "Publish.", "Run the program where it stays up", "Update and rotate."]);
  // What is not built yet says so.
  assert.match(list.replace(/\s+/g, " "), /by \*\*pairing\*\* \(Saltix 24-app-studio \[§3a\]/);
  assert.match(list.replace(/\s+/g, " "), /\*\*A developer key\*\* is retired: Saltix makes no new ones/);
  // A page needs no hosting: the network keeps its bundle, which grain publish puts there.
  assert.match(page.replace(/\s+/g, " "), /\*\*The network keeps the bundle\*\*: `grain publish` seals `public\/` and puts it from your computer straight into the Saltix network/);
  assert.doesNotMatch(page, /coming|will upload|needs a URL/i, "nothing about publishing is still to come");
  // Nothing private: no server's address, no real key.
  assert.doesNotMatch(page, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "no IP address");
  assert.doesNotMatch(page, /saltix-app:1:[a-z]+:[0-9a-f]/, "no developer key");
});
