// An offer's QR code as one SVG path (qrcode-generator: no canvas, no CDN, no inline style), dark on white in either
// colour scheme so every scanner reads it, with the quiet zone the standard asks for. As the explorer draws it.
import qrcode from "qrcode-generator";

/** Modules of light margin around the code. */
export const QUIET = 4;

export interface QrCode {
  /** The side in modules, the quiet zone included: the SVG's view box is `0 0 size size`. */
  size: number;
  /** The dark modules as one path: rows' runs of dark modules, a rectangle each. */
  path: string;
  /** A whole SVG element as text, for a page that draws it itself. */
  svg: string;
}

/** The QR code of `text` (byte mode, error correction M). */
export function qrCode(text: string): QrCode {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let end = c;
      while (end + 1 < n && qr.isDark(r, end + 1)) end++;
      path += `M${c + QUIET} ${r + QUIET}h${end - c + 1}v1h-${end - c + 1}z`;
      c = end;
    }
  }
  const size = n + 2 * QUIET;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Saltix Connect">` +
    `<rect width="${size}" height="${size}" fill="#FFFFFF"/><path d="${path}" fill="#0B1220"/></svg>`;
  return { size, path, svg };
}
