import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, validateAllowedHosts, validateHostname, validatePort, validateSettings } from "../src/config.js";

function baseSettings() {
  return {
    minimizeToTrayOnClose: true,
    piWeb: {
      port: "30141",
      hostname: "127.0.0.1",
      allowedHosts: "",
      password: "",
      commandPath: "",
      nodePath: "",
    },
  };
}

test("validatePort accepts valid values and rejects out-of-range ones", () => {
  assert.equal(validatePort("30141").ok, true);
  assert.equal(validatePort("").ok, true);
  assert.equal(validatePort("0").ok, false);
  assert.equal(validatePort("65536").ok, false);
  assert.equal(validatePort("abc").ok, false);
  assert.equal(validatePort("80.5").ok, false);
});

test("validateHostname rejects spaces and protocol prefixes", () => {
  assert.equal(validateHostname("127.0.0.1").ok, true);
  assert.equal(validateHostname("0.0.0.0").ok, true);
  assert.equal(validateHostname("").ok, true);
  assert.equal(validateHostname("127.0.0.1 ").ok, true);
  assert.equal(validateHostname("my host").ok, false);
  assert.equal(validateHostname("http://127.0.0.1").ok, false);
});

test("validateAllowedHosts checks comma separated entries", () => {
  assert.equal(validateAllowedHosts("").ok, true);
  assert.equal(validateAllowedHosts("pi.example.com, pi.local").ok, true);
  assert.equal(validateAllowedHosts("pi.example.com,").ok, false);
  assert.equal(validateAllowedHosts("pi example.com").ok, false);
});

test("validateSettings requires absolute executable paths", () => {
  const settings = baseSettings();
  assert.equal(validateSettings(settings).ok, true);

  const relative = baseSettings();
  relative.piWeb.commandPath = "pi-web.cmd";
  const result = validateSettings(relative);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /完整路径/);

  const absolute = baseSettings();
  absolute.piWeb.commandPath = "C:\\Users\\demo\\AppData\\Local\\npm-global\\pi-web.cmd";
  assert.equal(validateSettings(absolute).ok, true);
});

test("normalizeSettings falls back to defaults for missing or wrong types", () => {
  const normalized = normalizeSettings({ piWeb: { port: 30141, hostname: null }, minimizeToTrayOnClose: "yes" });
  assert.equal(normalized.piWeb.port, "30141");
  assert.equal(normalized.piWeb.hostname, "127.0.0.1");
  // 类型不符时回落到默认开启，避免读到损坏的配置文件导致行为突变。
  assert.equal(normalized.minimizeToTrayOnClose, true);
  assert.equal(normalized.piWeb.commandPath, "");
});

test("normalizeSettings keeps explicit false for the tray switch", () => {
  const normalized = normalizeSettings({ minimizeToTrayOnClose: false });
  assert.equal(normalized.minimizeToTrayOnClose, false);
});
