// The SDK's example grain: sign-in checked by its server, storage synced by the wallet, and a payment
// by an invoice its server signs and then finds on chain.
import { grain, inWallet, walletLink } from "/packages/grain/dist/index.js";

const out = document.getElementById("out");
const show = (x) => { out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); };
const run = (id, fn) => document.getElementById(id).addEventListener("click", () => fn().catch((e) => show(`${e.code ?? ""} ${e.message}`)));

if (!inWallet()) {
  show("Open this grain in a Salarium wallet:\n" + walletLink(`${location.origin}/.well-known/salarium-grain`));
} else {
  grain.info().then((info) => { document.body.dataset.theme = info.theme; show(info); });
  grain.on("theme", ({ theme }) => { document.body.dataset.theme = theme; });
  grain.ready();
}

run("login", async () => {
  const { challenge } = await (await fetch("/api/challenge")).json();
  const answer = await grain.login(challenge);
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer, challenge }) });
  show(await r.json());
});
run("save", async () => { await grain.storage.set("note", document.getElementById("note").value); show("saved"); });
run("read", async () => show({ note: await grain.storage.get("note"), keys: await grain.storage.keys() }));
run("address", async () => show({ address: await grain.requestAddress() }));
run("pay", async () => {
  const { invoice, reference } = await (await fetch("/api/invoice")).json();
  const paid = await grain.pay({ invoice });
  show({ paid, waiting: "for a block…" });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { payment } = await (await fetch(`/api/paid?reference=${reference}`)).json();
    if (payment) return show({ paid, payment });
  }
  show({ paid, payment: "not in a block yet" });
});
