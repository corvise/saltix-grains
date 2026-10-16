#!/usr/bin/env node
// The `grain` command: the built command line, dist/main.js. This file is in the repository, so npm links `grain` when
// it installs the workspace, before `npm run build` has made dist/ (npm links no command whose file is missing).
const main = new URL("../dist/main.js", import.meta.url);
try {
  await import(main.href);
} catch (e) {
  // Only dist/main.js itself missing: a module the built tool cannot find is a fault of its own, shown as it is.
  if (e?.code === "ERR_MODULE_NOT_FOUND" && e.url === main.href) {
    console.error("grain: the command line is not built yet: run `npm run build` in the saltix-grains checkout");
    process.exit(1);
  }
  throw e;
}
