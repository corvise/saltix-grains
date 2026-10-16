// Saltix's mark as the button and the dialog draw it: an S on a sky-blue tile, built with DOM calls (classes only, no
// inline style and no markup parsed), so a page under a strict Content Security Policy or Trusted Types draws it too.

const SVG = "http://www.w3.org/2000/svg";

/** The S: one stroke, round ends, in a 24 × 24 box. */
export const MARK_PATH = "M16.2 8.1c-.8-1.4-2.4-2.3-4.3-2.3-2.4 0-4.1 1.3-4.1 3.1 0 4.1 8.6 2.4 8.6 6.5 0 1.9-1.8 3.2-4.4 3.2-2 0-3.7-.9-4.6-2.4";

/** The mark as an `svg` element of `doc`, with the class `className`. */
export function markElement(doc: Document, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg") as SVGSVGElement;
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const tile = doc.createElementNS(SVG, "rect");
  tile.setAttribute("class", "saltix-mark__tile");
  for (const [k, v] of [["x", "1"], ["y", "1"], ["width", "22"], ["height", "22"], ["rx", "6"]]) tile.setAttribute(k!, v!);
  const s = doc.createElementNS(SVG, "path");
  s.setAttribute("class", "saltix-mark__s");
  s.setAttribute("d", MARK_PATH);
  svg.append(tile, s);
  return svg;
}
