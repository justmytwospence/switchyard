// Source-checkout entry for Node 24 type stripping. The build emits server.ts as
// dist/hello/server.js, so the same manifest works in source and built directories.
export { default } from "./server.ts";
