// The development relay lives in the server SDK (`@saltix/grain-server/dev`, packages/server/src/dev.ts) so that apps'
// tests and the command line use it too; this path stays for the repository's own scripts and tests.
export { createDevRelay } from "../packages/server/dist/dev.js";
