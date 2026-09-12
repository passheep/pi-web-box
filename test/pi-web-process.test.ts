import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parsePort, quoteCmdArg, isHealthyPiWebStatus, resolvePiWebEntry } from "../src/pi-web-process.js";

test("parsePort accepts valid TCP ports", () => {
  assert.equal(parsePort("30141"), 30141);
  assert.throws(() => parsePort("0"));
  assert.throws(() => parsePort("65536"));
  assert.throws(() => parsePort("abc"));
});

test("quoteCmdArg safely quotes Windows paths", () => {
  assert.equal(quoteCmdArg("C:\\Program Files\\pi-web.cmd"), '"C:\\Program Files\\pi-web.cmd"');
  assert.equal(quoteCmdArg("simple"), "simple");
});

test("pi-web entry is resolved relative to the global command", () => {
  assert.equal(
    resolvePiWebEntry("C:\\Program Files\\npm\\pi-web.cmd"),
    path.join("C:\\Program Files\\npm", "node_modules", "@agegr", "pi-web", "bin", "pi-web.js"),
  );
});

test("health check accepts Pi Web and rejects unrelated status", () => {
  assert.equal(isHealthyPiWebStatus(200, "<title>Pi Web</title>"), true);
  assert.equal(isHealthyPiWebStatus(200, "hello"), false);
  assert.equal(isHealthyPiWebStatus(500, "Pi Web"), false);
});
