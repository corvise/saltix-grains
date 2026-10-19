// Directories of a test file's own under the system's temporary directory, removed once the file's tests are done,
// failed ones included: `node --test` runs each file in a process of its own, and this module's `after` hook is that
// file's. A test that makes a directory, a file or a project takes it from here, never from `mkdtempSync` itself, so
// nothing is left behind (CI fails a run that leaves anything in its temporary directory, .github/workflows/ci.yml).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made = [];

after(() => {
  // A process a test started may still be closing a file there: retried, as rmSync does for a directory not yet empty.
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A new, empty directory named `<prefix>XXXXXX`, removed after the file's last test. */
export function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
