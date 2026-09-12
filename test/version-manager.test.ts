import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isNewerVersion } from "../src/version-manager.js";

test("compareVersions compares stable semantic versions", () => {
  assert.equal(compareVersions("0.84.2", "0.84.2"), 0);
  assert.equal(compareVersions("0.84.3", "0.84.2"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.8.9", "0.10.0"), -1);
});

test("stable versions are newer than prereleases", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
});

test("isNewerVersion only reports a strictly newer latest version", () => {
  assert.equal(isNewerVersion("0.8.9", "0.9.0"), true);
  assert.equal(isNewerVersion("0.9.0", "0.9.0"), false);
  assert.equal(isNewerVersion("1.0.0", "0.9.0"), false);
});
