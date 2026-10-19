// A Chromium-family browser installed on this computer, driven headless over the DevTools protocol through a pipe
// (`--remote-debugging-pipe`: messages on file descriptors 3 and 4, each ended by a NUL byte), for `grain dev --check`.
// No package downloads a browser and no port is opened: the SDK uses the Chrome, Chromium, Edge or Brave the developer
// has (or the one `CHROME_PATH` names), with a profile and a temporary directory of its own that it removes after.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Where each system keeps the browsers the check can drive, in the order they are tried. */
const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX_COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS_PATHS = ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "Chromium/Application/chrome.exe"];

/**
 * The browser the check drives: `CHROME_PATH` (or `SALTIX_BROWSER`) when it names one that exists, else the first
 * installed of Chrome, Chromium, Edge and Brave in the system's usual places (macOS's Applications, the `PATH` on Linux,
 * Program Files on Windows); null when there is none.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists = existsSync): string | null {
  for (const named of [env.CHROME_PATH, env.SALTIX_BROWSER]) {
    if (named && exists(named)) return named;
  }
  const candidates: string[] = [];
  if (platform === "darwin") {
    for (const root of ["/Applications", join(env.HOME ?? homedir(), "Applications")]) candidates.push(...MAC_APPS.map((app) => join(root, app)));
  } else if (platform === "win32") {
    for (const root of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (root) candidates.push(...WINDOWS_PATHS.map((p) => join(root, p)));
    }
  } else {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(...LINUX_COMMANDS.map((c) => join(dir, c)));
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/** An event of the protocol: its method, its parameters and the session it came from. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** The DevTools protocol over the browser's pipe. */
export class Browser {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private readonly listeners: Array<(e: CdpEvent) => void> = [];
  private buffer = "";
  private closed = false;
  /** The browser's last words on stderr, for a launch that fails. */
  private stderr = "";

  private constructor(private readonly child: ChildProcess, private readonly profile: string) {
    const read = child.stdio[4] as Readable;
    read.setEncoding("utf8");
    read.on("data", (chunk: string) => this.received(chunk));
    // A browser that goes away resets its end of the pipe (ECONNRESET on Linux, a plain end elsewhere): never an error of
    // ours to throw. Its exit, below, says why, once its stderr has ended.
    read.on("error", (e) => {
      this.pipeError ??= e.message;
    });
    (child.stdio[3] as Writable).on("error", (e) => {
      this.pipeError ??= e.message;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.on("error", (e) => this.fail(new Error(`the browser did not start: ${e.message}`)));
    // On "close", after its stderr ended: its last words say why (a sandbox it was not given, a missing library).
    child.on("close", (code, signal) => {
      const words = this.stderr.trim().split("\n").filter((l) => l.trim() !== "").slice(-3).join(" ");
      this.fail(new Error(`the browser exited (${signal ?? `status ${code}`})${words ? `: ${words}` : this.pipeError ? `: ${this.pipeError}` : ""}`));
    });
  }

  /** What the pipe said when the browser went away, if anything. */
  private pipeError: string | null = null;

  /** Start `path` headless with a profile in `profile` (made empty, removed by `close`), its temporary files there too;
   *  `sandbox: false` only where the system gives the browser none (a container, or Linux that forbids its namespaces). */
  static launch(path: string, profile: string, sandbox = true): Browser {
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(join(profile, "tmp"), { recursive: true });
    const args = [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${join(profile, "data")}`, "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync",
      "--disable-component-update", "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb",
      "--window-size=1900,1300",
    ];
    // A container's /dev/shm is small; a root user has no sandbox.
    if (process.platform === "linux") args.push("--disable-dev-shm-usage");
    if (!sandbox || (typeof process.getuid === "function" && process.getuid() === 0)) args.push("--no-sandbox");
    const tmp = join(profile, "tmp");
    const child = spawn(path, [...args, "about:blank"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
    return new Browser(child, profile);
  }

  private received(chunk: string): void {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\0"); end >= 0; end = this.buffer.indexOf("\0")) {
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        const waiter = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!waiter) continue;
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
      } else if (message.method) {
        const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
        for (const listen of this.listeners) listen(event);
      }
    }
  }

  private fail(e: Error): void {
    this.closed = true;
    for (const waiter of this.waiting.values()) waiter.reject(e);
    this.waiting.clear();
  }

  /** Call `method` (of a page's session, with `sessionId`), at most `ms` long. */
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string, ms = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: the browser is closed`));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: no answer in ${ms / 1000} s`));
      }, ms);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      (this.child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  on(listen: (e: CdpEvent) => void): void {
    this.listeners.push(listen);
  }

  /** A new tab, attached: its session's id. */
  async tab(): Promise<string> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  /** Close the browser and remove its profile and temporary files. */
  async close(): Promise<void> {
    if (!this.closed) {
      await this.send("Browser.close", {}, undefined, 3_000).catch(() => undefined);
      this.closed = true;
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 3_000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // The browser may still be writing its last files for a moment.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
