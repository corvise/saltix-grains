// The page of the example site: the courier of the server-held mode (Saltix 19-connect §15). It asks its own server
// for the offer, opens the slot at a relay, shows the Sign in with Saltix dialog, forwards what the slot receives,
// and renders what the server answered: no key, no login and no check lives here. The session is the server's cookie,
// so the page asks `/me` who is signed in, never a storage of its own.
import { createConnect, openConnectDialog, signInButton } from "./saltix-connect.js";

const config = await (await fetch("/config.json", { credentials: "same-origin" })).json();
const connect = createConnect({ network: config.network, relays: config.relays, server: config.server });
const lang = document.documentElement.lang === "ru" ? "ru" : "en";
const el = (id) => document.getElementById(id);

async function me() {
  const r = await fetch("/me", { credentials: "same-origin", cache: "no-store" });
  return r.ok ? r.json() : null;
}

function render(session) {
  el("status").hidden = true;
  el("who").hidden = !session;
  el("signout").hidden = !session;
  el("signin").hidden = !!session;
  if (session) el("who").textContent = `Signed in as ${session.address} since ${new Date(session.since).toLocaleString()}`;
}

signInButton(el("signin"), {
  lang,
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  onClick: async () => {
    // Resolves once the server opened the session (its cookie is set by then); the dialog showed every step.
    const connection = await openConnectDialog(connect, { lang });
    if (connection) render(await me());
  },
});
el("signout").addEventListener("click", async () => {
  await fetch("/signout", { method: "POST", credentials: "same-origin" });
  render(null);
});
// A phone's browser behind Saltix: the slot is opened again the moment the page is in front (19-connect §14.1).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") connect.wake();
});
render(await me());
