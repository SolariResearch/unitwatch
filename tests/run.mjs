import assert from "node:assert/strict";
import "../public/js/engine.js";
const U = globalThis.Unitwatch;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log("ok", name);
  } catch (e) {
    failed++;
    console.log("FAIL", name, e.message);
  }
}
t("parses start-limit-hit", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_STATUS);
  assert.equal(p.unit, "shop-api.service");
  assert.equal(p.activeState, "failed");
  assert.equal(p.result, "start-limit-hit");
  assert.equal(p.startLimitHit, true);
  assert.equal(p.exitStatus, "1");
  assert.ok(p.issues.some((i) => i.code === "start-limit-hit"));
  assert.ok(p.issues.some((i) => i.code === "addr-in-use"));
});
t("parses journal snippet", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_JOURNAL);
  assert.equal(p.kind, "journal");
  assert.equal(p.unit, "nginx.service");
  assert.equal(p.result, "exit-code");
});
t("parses active unit", () => {
  const blob = "\u25cf nginx.service - A high performance web server\n     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled; preset: enabled)\n    Drop-In: /etc/systemd/system/nginx.service.d\n             \u2514\u2500override.conf\n     Active: active (running) since Mon 2026-08-31 12:00:00 UTC; 2h ago\n   Main PID: 1234 (nginx)";
  const p = U.parseSystemdStatus(blob);
  assert.equal(p.unit, "nginx.service");
  assert.equal(p.activeState, "active");
  assert.equal(p.subState, "running");
  assert.equal(p.mainPid, "1234");
  assert.ok(p.dropIns.length >= 1);
});
t("drop-in policy", () => {
  const d = U.proposeRestartDropin({ unit: "shop-api", restart: "always", restartSec: 5, startLimitIntervalSec: 0 });
  assert.equal(d.unit, "shop-api.service");
  assert.equal(d.files.length, 1);
  assert.ok(d.files[0].path.endsWith("10-unitwatch-restart.conf"));
  assert.match(d.files[0].content, /Restart=always/);
  assert.match(d.files[0].content, /RestartSec=5/);
  assert.match(d.files[0].content, /StartLimitIntervalSec=0/);
});
t("watchdog timer", () => {
  const w = U.proposeWatchdogTimer({ unit: "shop-api.service", host: "127.0.0.1", port: 8080, intervalSec: 30 });
  assert.equal(w.files.length, 2);
  assert.match(w.files[0].content, /\/dev\/tcp\/127\.0\.0\.1\/8080/);
  assert.match(w.files[1].content, /OnUnitActiveSec=30/);
});
t("rollback", () => {
  const r = U.proposeRollback({ unit: "shop-api.service" });
  assert.ok(r.filesToRemove.some((p) => p.includes("10-unitwatch-restart.conf")));
  assert.match(r.files[0].content, /rm -f "\$DROPIN"/);
});
t("hardening plan", () => {
  const plan = U.proposeHardeningPlan({ statusBlob: U.SAMPLE_STATUS, restart: "always" });
  assert.equal(plan.unit, "shop-api.service");
  assert.equal(plan.parsed.result, "start-limit-hit");
  assert.equal(plan.files.length, 4);
});
t("rejects traversal", () => {
  assert.throws(() => U.sanitizeUnit("../evil.service"), /paths/);
  assert.throws(() => U.sanitizeUnit("foo/bar.service"), /paths/);
});
t("guesses 8080", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_STATUS);
  assert.equal(U.guessPort(p, {}), 8080);
});
if (failed) {
  console.log("failed", failed);
  process.exit(1);
}
console.log("all ok");
