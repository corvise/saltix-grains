// The "Sign in with Saltix" button (Saltix 19-connect §13): Saltix's mark at its left and the words "Sign in with Saltix"
// ("Войти через Saltix"), on Saltix's navy with white text, or white with navy text on a dark page; at least 44 px tall,
// its corners rounded by a quarter of its height. Its look is fixed so that users recognise it everywhere: the classes
// of `connect.css` draw it, and the page sets no style of its own on it.
import { markElement } from "./mark.js";
import { type Lang, WORDS } from "./words.js";

/** The classes the button standard uses (connect.css). */
export const BUTTON_CLASSES = {
  button: "saltix-signin",
  /** Navy with white text: for a light page. */
  navy: "saltix-signin--navy",
  /** White with navy text: for a dark page. */
  white: "saltix-signin--white",
  mark: "saltix-signin__mark",
  label: "saltix-signin__label",
} as const;

export interface ButtonOptions {
  /** The words' language: `en` (the default) or `ru`. */
  lang?: Lang;
  /** The page's theme: `light` (the default) draws the navy button, `dark` the white one. */
  theme?: "light" | "dark";
  onClick?: (event: MouseEvent) => void;
}

/**
 * Make `el` the "Sign in with Saltix" button: `el` itself when it is a `<button>` (its content is replaced), else a new
 * `<button type="button">` appended to it. Returns the button.
 */
export function signInButton(el: HTMLElement, o: ButtonOptions = {}): HTMLButtonElement {
  const doc = el.ownerDocument;
  const button = el.tagName === "BUTTON" ? (el as HTMLButtonElement) : (el.appendChild(doc.createElement("button")) as HTMLButtonElement);
  if (button !== el) button.setAttribute("type", "button");
  const words = WORDS[o.lang ?? "en"];
  for (const c of [BUTTON_CLASSES.navy, BUTTON_CLASSES.white]) button.classList.remove(c);
  button.classList.add(BUTTON_CLASSES.button, o.theme === "dark" ? BUTTON_CLASSES.white : BUTTON_CLASSES.navy);
  const label = doc.createElement("span");
  label.className = BUTTON_CLASSES.label;
  label.textContent = words.signIn;
  button.replaceChildren(markElement(doc, BUTTON_CLASSES.mark), label);
  button.setAttribute("lang", o.lang ?? "en");
  if (o.onClick) button.addEventListener("click", o.onClick);
  return button;
}
