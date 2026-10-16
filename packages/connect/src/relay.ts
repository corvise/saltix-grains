// The page's connection to a relay for Saltix Connect (Saltix 09-relay §3, §10.3): a WebSocket of JSON frames, the
// relay's `hello` first. Relays serve their clients over TLS with self-signed certificates that apps pin (09-relay
// §10.1); a browser cannot pin, so a page reaches them through a WebSocket path of its own site that pins them (as
// saltix.io's `/explorer/r/1..3/`), or through a public gateway once one exists. A port of the explorer's
// `explorer/src/connect/relay.ts`.
import { fromB64Loose } from "./codec.js";

export type Frame = { type: string; [field: string]: unknown };

/** One relay connection after its hello: what the session needs of it. */
export interface RelayLink {
  /** The relay's node key from its hello. */
  readonly relay: Uint8Array;
  /** The relay's network kind: `mainnet`, `testnet`, `devnet`. */
  readonly network: string;
  send(frame: Frame): boolean;
  onFrame: (f: Frame) => void;
  onClose: () => void;
  close(): void;
}

/** Opens a connection to the relay behind `base` and waits for its hello. */
export type Dial = (base: string) => Promise<RelayLink>;

/** The WebSocket address of a relay: a `wss://` (or `ws://`) URL as it is, or a path on this site (`/saltix/r/1/`). */
export function wsUrl(base: string, loc: { protocol: string; host: string } = location): string {
  if (/^wss?:\/\//.test(base)) return base;
  const path = base.endsWith("/") ? base : `${base}/`;
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}

const HELLO_MS = 5_000;

/** Connect to the relay behind `base` with the browser's WebSocket and wait for its hello. */
export const dialWebSocket: Dial = (base) =>
  new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(base));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let link: (RelayLink & { closed: boolean }) | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no hello"));
    }, HELLO_MS);
    ws.onmessage = (ev) => {
      let f: Frame;
      try {
        f = JSON.parse(String(ev.data)) as Frame;
      } catch {
        return;
      }
      if (typeof f !== "object" || f === null || typeof f.type !== "string") return;
      if (!link) {
        const relay = f.type === "hello" ? fromB64Loose(String(f.relay)) : null;
        clearTimeout(timer);
        if (!relay || relay.length !== 32) {
          ws.close();
          reject(new Error("bad hello"));
          return;
        }
        link = {
          relay,
          network: String(f.network),
          closed: false,
          send: (frame) => {
            if (ws.readyState !== WebSocket.OPEN) return false;
            ws.send(JSON.stringify(frame));
            return true;
          },
          onFrame: () => {},
          onClose: () => {},
          close: () => {
            if (link) link.closed = true;
            ws.close();
          },
        };
        resolve(link);
        return;
      }
      link.onFrame(f);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timer);
      if (!link) {
        reject(new Error("closed"));
        return;
      }
      // A close the page asked for is not news.
      if (!link.closed) link.onClose();
    };
  });
