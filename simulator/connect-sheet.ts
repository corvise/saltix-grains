/**
 * A preview of Saltix's Connect sheet (Saltix 19-connect §12), the wallet's own screen the first time an account opens an
 * app: "Saltix Connect" on top, the app's identity, its profile "In its own words" (`connect.json`, which `grain dev`
 * serves at `/_connect.json`), "To continue, sign in" with a row for each permission the manifest asks for (the address
 * and notifications behind switches, off by default), the privacy summary and links, then Continue or Cancel. Drawn
 * inside the same frame as a page (the safe area, below the controls' band); it rises from the bottom on a phone and
 * floats in the middle on a wide screen. A preview only: the wallet's own design, and its checks of the profile, are
 * Saltix's (the registry's record adds the username, mark, owner, category and ratings).
 */
import type { SafeArea } from "../packages/grain/src/index";
import { PERMISSIONS } from "../packages/server/src/manifest";
import { type ConnectProfile, profileFromJson, profileProblem, profileText } from "../packages/server/src/profile";

/** Where `grain dev` (and `npm run dev`) serves the project's `connect.json`. */
export const CONNECT_PATH = "/_connect.json";

type Lang = "en" | "ru";

const WORDS = {
  en: {
    preview: "A preview of Saltix's Connect sheet",
    ownWords: "In its own words",
    noProfile: "It has no Connect profile: Saltix shows its manifest's description, all its owner wrote.",
    signIn: "To continue, sign in",
    recognise: ["Recognise you", "A pseudonymous ID for this app only, unlinkable to other apps. It does not see your address."],
    address: ["Your wallet address", "It can follow your activity on the blockchain: balances, transfers, names."],
    notifications: ["Notifications", "Up to 10 a day, off at any time."],
    storage: ["Storage", "Up to 1 MiB of its data, encrypted in your vault and synced across your devices."],
    relay: ["Messages through Saltix relays", "Under its ID for you, never your address."],
    camera: ["Camera", "The phone asks the first time."],
    microphone: ["Microphone", "The phone asks the first time."],
    location: ["Location", "The phone asks the first time."],
    payments: ["Payments and contacts", "It can ask you to pay or to pick a contact; you confirm each one in Saltix."],
    hosted: "A hosted app's owner can change its code at any time.",
    never: "Saltix never asks for your phrase or your PIN inside an app.",
    continue: "Continue",
    cancel: "Cancel",
    website: "Website",
    support: "Support",
    terms: "Terms",
    by: "by",
  },
  ru: {
    preview: "Предпросмотр листа Saltix Connect",
    ownWords: "Своими словами",
    noProfile: "У приложения нет профиля Connect: Saltix показывает описание из манифеста — всё, что написал владелец.",
    signIn: "Чтобы продолжить, войдите",
    recognise: ["Узнавать вас", "Псевдонимный идентификатор только для этого приложения, не связанный с другими. Ваш адрес оно не видит."],
    address: ["Адрес вашего кошелька", "Оно сможет следить за вашей активностью в блокчейне: балансы, переводы, имена."],
    notifications: ["Уведомления", "До 10 в день, отключаются в любой момент."],
    storage: ["Хранилище", "До 1 МиБ его данных, зашифрованных в вашем хранилище и синхронизированных между устройствами."],
    relay: ["Сообщения через релеи Saltix", "Под его идентификатором для вас, никогда не под вашим адресом."],
    camera: ["Камера", "Телефон спросит в первый раз."],
    microphone: ["Микрофон", "Телефон спросит в первый раз."],
    location: ["Местоположение", "Телефон спросит в первый раз."],
    payments: ["Платежи и контакты", "Оно может попросить оплатить или выбрать контакт; каждое действие вы подтверждаете в Saltix."],
    hosted: "Владелец приложения на своём сайте может менять его код в любой момент.",
    never: "Saltix никогда не спрашивает фразу или PIN внутри приложения.",
    continue: "Продолжить",
    cancel: "Отмена",
    website: "Сайт",
    support: "Поддержка",
    terms: "Условия",
    by: "владелец",
  },
} as const;

/** The manifest's fields the sheet shows. */
export interface SheetManifest {
  slug: string;
  owner: string;
  name: Record<string, string>;
  description: Record<string, string>;
  permissions: number;
  entry: Record<string, unknown>;
}

/** What the user chose: the switches as set, or null for Cancel (or Back). */
export type SheetChoice = { address: boolean; notifications: boolean } | null;

export interface SheetHost {
  phone: HTMLElement;
  /** Where a page is laid out: the safe area, below the controls' band. */
  frame(): { view: SafeArea; width: number; height: number };
  lang(): string;
  theme(): "dark" | "light";
  log(line: string): void;
}

/** The project's profile as `connect.json` holds it, with the manifest's owner and revision 1, and why a wallet would
 *  refuse it (the format's reason), or null when there is none. */
export async function fetchProfile(manifestUrl: string, owner: string): Promise<{ profile: ConnectProfile | null; problem: string | null }> {
  let value: unknown;
  try {
    const response = await fetch(new URL(CONNECT_PATH, manifestUrl), { cache: "no-store" });
    if (!response.ok) return { profile: null, problem: null };
    value = await response.json();
  } catch {
    return { profile: null, problem: "json" };
  }
  try {
    const profile = profileFromJson({ ...(value as object), owner, revision: 1 });
    return { profile, problem: profileProblem(profile) };
  } catch (e) {
    return { profile: null, problem: (e as Error).message };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Show the sheet for `m` with `profile` over the phone; resolves with the user's choice. */
export function showConnectSheet(host: SheetHost, m: SheetManifest, profile: ConnectProfile | null, problem: string | null): Promise<SheetChoice> {
  const lang: Lang = host.lang() === "ru" ? "ru" : "en";
  const w = WORDS[lang];
  const { view, width, height } = host.frame();
  const wide = width >= 600;
  const scrim = el("div", `connect-scrim${wide ? " wide" : ""}`);
  // The page's frame: clear of the status bar, a cutout, the controls' band, the navigation bar and the corners.
  Object.assign(scrim.style, { top: `${view.top}px`, left: `${view.left}px`, right: `${view.right}px`, bottom: `${view.bottom}px` });
  const sheet = el("div", `connect-sheet ${host.theme()}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Saltix Connect");
  sheet.style.maxHeight = `${height - view.top - view.bottom - (wide ? 32 : 0)}px`;

  const head = el("div", "cs-head");
  head.append(el("span", "cs-mark", "S"), el("strong", "", "Saltix Connect"));
  const preview = el("div", "cs-preview", w.preview);

  const name = m.name[lang] ?? m.name.en ?? m.slug;
  const who = el("div", "cs-who");
  const titles = el("div", "cs-titles");
  titles.append(el("strong", "cs-name", name), el("span", "cs-meta", `${m.slug} · ${w.by} ${m.owner.slice(0, 8)}…`));
  who.append(el("div", "cs-icon", name.slice(0, 1).toUpperCase()), titles);

  const words = el("section", "cs-words");
  words.append(el("div", "cs-label", w.ownWords));
  if (profile && problem === null) {
    const t = profileText(profile, lang);
    words.append(el("p", "cs-tagline", t.tagline));
    if (t.about) words.append(el("p", "cs-about", t.about));
    if (t.highlights.length > 0) {
      const ul = el("ul", "cs-highlights");
      for (const h of t.highlights) ul.append(el("li", "", h));
      words.append(ul);
    }
  } else {
    words.append(el("p", "cs-about", m.description[lang] ?? m.description.en ?? ""), el("p", "cs-note", w.noProfile));
    if (problem) words.append(el("p", "cs-bad", `connect.json: ${problem} (grain lint says more)`));
  }

  const rows = el("section", "cs-rows");
  rows.append(el("div", "cs-label", w.signIn));
  const switches: { address?: HTMLInputElement; notifications?: HTMLInputElement } = {};
  const row = (key: keyof typeof w & ("recognise" | "address" | "notifications" | "storage" | "relay" | "camera" | "microphone" | "location" | "payments"), toggle = false) => {
    const r = el("label", "cs-row");
    const text = el("span", "cs-row-text");
    text.append(el("strong", "", w[key][0]), el("span", "", w[key][1]));
    r.append(el("span", `cs-row-icon ${key}`), text);
    if (toggle) {
      const input = el("input", "cs-switch");
      input.type = "checkbox";
      input.checked = false;
      r.append(input);
      switches[key as "address" | "notifications"] = input;
    }
    rows.append(r);
  };
  row("recognise");
  const p = m.permissions;
  if (p & PERMISSIONS.address) row("address", true);
  if (p & PERMISSIONS.notifications) row("notifications", true);
  if (p & PERMISSIONS.storage) row("storage");
  if (p & PERMISSIONS.relay) row("relay");
  if (p & PERMISSIONS.camera) row("camera");
  if (p & PERMISSIONS.microphone) row("microphone");
  if (p & PERMISSIONS.location) row("location");
  row("payments");

  const foot = el("section", "cs-foot");
  if (profile && problem === null) {
    const t = profileText(profile, lang);
    if (t.privacy) foot.append(el("p", "cs-privacy", t.privacy));
    const links = el("p", "cs-links");
    for (const [label, link] of [[w.website, profile.website], [w.support, profile.support], [w.terms, profile.terms]] as const) {
      // Links as text: the wallet opens them outside the app; a preview opens nothing.
      if (link) links.append(el("span", "", `${label}: ${link}`));
    }
    if (links.childElementCount > 0) foot.append(links);
  }
  if ("hosted" in m.entry) foot.append(el("p", "cs-note", w.hosted));
  foot.append(el("p", "cs-note", w.never));

  const actions = el("div", "cs-actions");
  const go = el("button", "cs-continue", w.continue);
  const cancel = el("button", "cs-cancel", w.cancel);
  actions.append(go, cancel);
  sheet.append(head, preview, who, words, rows, foot, actions);
  scrim.append(sheet);
  host.phone.append(scrim);
  return new Promise<SheetChoice>((resolve) => {
    const done = (choice: SheetChoice) => {
      scrim.remove();
      resolve(choice);
    };
    go.onclick = () => done({ address: switches.address?.checked ?? false, notifications: switches.notifications?.checked ?? false });
    cancel.onclick = () => done(null);
  });
}
