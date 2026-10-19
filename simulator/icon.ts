/**
 * The app's icon where the wallet draws it (the Connect sheet, the splash): the project's own icon file, which `grain dev`
 * serves at `/_icon.png` when it is the one `grain.json` names, in Saltix's rounded square (corners 0.26 of the side,
 * Saltix 32-images §3.2); the name's first letter while it loads or when there is none, as Saltix draws an app without
 * an icon.
 */

/** Where `grain dev` serves the icon `grain.json` names. */
export const ICON_PATH = "/_icon.png";

/** Draw the icon at `url` (null: none) in `el`, its name's first letter until the picture has loaded. */
export function drawIcon(el: HTMLElement, url: string | null, name: string): void {
  if (url !== null && el.dataset.icon === url && el.querySelector("img")) return;
  el.dataset.icon = url ?? "";
  el.textContent = name.slice(0, 1).toUpperCase();
  if (url === null) return;
  const img = new Image();
  img.alt = "";
  img.className = "app-icon";
  img.onload = () => {
    if (el.dataset.icon === url) el.replaceChildren(img);
  };
  img.src = url;
}
