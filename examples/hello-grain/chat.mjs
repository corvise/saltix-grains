// The example grain's chat (Saltix 22-grain-chats): three commands that show every block a card has — text, fields,
// a secret, a file, an invoice and a status — and every action: run, open and reply. `server.mjs` runs it from a
// developer key on a real network; `npm run dev` on the development relay.
import { randomBytes } from "node:crypto";
import { ChatServer, ChatRefusal, card, signInvoice, toHex } from "../../packages/server/dist/index.js";

const SITES = { web: "Web", docs: "Docs" };
const human = (seconds) => (seconds >= 86_400 ? `${seconds / 86_400} day(s)` : seconds >= 3_600 ? `${seconds / 3_600} hour(s)` : `${seconds / 60} minutes`);

/** A day's made-up sessions as CSV: `top` rows, errors only if asked. */
function sessions(day, top, errorsOnly) {
  const rows = [];
  for (let i = 0; rows.length < top && i < 1_000; i++) {
    const error = i % 7 === 3;
    if (errorsOnly && !error) continue;
    rows.push(`${day},s-${String(i).padStart(4, "0")},${(i * 37) % 600} s,${error ? "error" : "ok"}`);
  }
  return { csv: ["day,session,length,result", ...rows].join("\n") + "\n", rows: rows.length };
}

/** Whether the grain has a screen to open: a chat-only one (24-app-studio §2) has none. Without a registry to ask, it
 *  is this example's own grain, which has. */
const hasScreen = (chat) => !chat.grain?.manifest || !("chat" in chat.grain.manifest.manifest.entry);

/**
 * Start the chat: `options` are `ChatServer.start`'s (a developer key, or the slug, server key and certificate, and the
 * spec and relays); `owner` is the account invoices pay, when the server key has a certificate that lets it sign them.
 */
export async function startChat(options, owner = null) {
  const chat = await ChatServer.start(options);

  chat.command("hello", (ask) => {
    const c = card()
      .text(`Hello, ${ask.args.name ?? "friend"}! This is an app's chat: every card is signed by a key the app's registry record names, so your wallet marks it verified.`)
      .fields({ "You are, to this app": `${ask.key.slice(0, 16)}…`, "Asked at": new Date(ask.request.at).toISOString() });
    if (ask.member) c.fields({ "Your account (a private app knows it)": `${ask.member.account.slice(0, 16)}…` });
    c.reply("Thanks");
    if (hasScreen(chat)) c.open("Open the grain", "chat");
    return c.run("Get a key", "key", { site: "web", duration: 600 });
  });

  chat.command("key", (ask) => {
    const { site, duration } = ask.args;
    const code = toHex(randomBytes(5)).toUpperCase().replace(/(.{4})(.{4})(.{2})/, "$1-$2-$3");
    return card()
      .secret("Key", code, { expiresAt: Date.now() + duration * 1000 })
      .fields({ Site: SITES[site], "Valid for": human(duration) })
      .status("done", "A made-up key: the example mints nothing")
      .run("Another", "key", { site, duration });
  });

  chat.command("report", async (ask) => {
    const day = ask.args.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const top = Number(ask.args.top ?? 20n);
    if (day > new Date().toISOString().slice(0, 10)) throw new ChatRefusal("That day has not come yet.");
    await ask.working("Building the report…");
    const { csv, rows } = sessions(day, top, ask.args.errors_only === true);
    const file = await chat.upload(new TextEncoder().encode(csv), { name: `sessions-${day}.csv`, mime: "text/csv" });
    const c = card()
      .text(`Sessions of ${day}: ${rows} rows${ask.args.errors_only ? ", errors only" : ""}.\nThe file has every row.`)
      .file(file, { title: `Sessions, ${day}`, format: "csv" });
    // An invoice is signed by the owner key or a key it certified (12-grains §5.2): a registered key alone signs none.
    if (options.cert && options.secret && owner) {
      c.invoice(signInvoice({
        slug: chat.slug, to: owner, asset: "SALT", amount: 1_000_000n, memo: "Thanks for the example", reference: toHex(randomBytes(16)),
        expires_at: Date.now() + 10 * 60_000,
      }, options.secret, chat.chain.genesis, options.cert));
      return c.status("done", "The invoice is optional: the simulator makes no payment");
    }
    return c.status("done");
  });

  chat.text((ask) => card().text(`You wrote: “${ask.text.slice(0, 200)}”. This chat answers its commands: hello, key and report.`).reply("Hello", "hello"));
  return chat;
}
