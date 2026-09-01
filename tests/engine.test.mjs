import test from "node:test";
import assert from "node:assert/strict";
import "../public/js/engine.js";
const U = globalThis.Unitwatch;

test("parses a failed start-limit-hit status blob", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_STATUS);
  assert.equal(p.unit, "shop-api.service");
  assert.equal(p.activeState, "failed");
  assert.equal(p.result, "start-limit-hit");
  assert.equal(p.startLimitHit, true);
  assert.equal(p.exitStatus, "1");
  assert.ok(p.issues.some((i) => i.code === "start-limit-hit"));
  assert.ok(p.issues.some((i) => i.code === "addr-in-use"));
});

test("parses a journal snippet without a Loaded: header", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_JOURNAL);
  assert.equal(p.kind, "journal");
  assert.equal(p.unit, "nginx.service");
  assert.equal(p.result, "exit-code");
});

test("parses an active unit", () => {
  const blob = `● nginx.service - A high performance web server
     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/nginx.service.d
             └─override.conf
     Active: active (running) since Mon 2026-08-31 12:00:00 UTC; 2h ago
   Main PID: 1234 (nginx)`;
  const p = U.parseSystemdStatus(blob);
  assert.equal(p.unit, "nginx.service");
  assert.equal(p.activeState, "active");
  assert.equal(p.subState, "running");
  assert.equal(p.mainPid, "1234");
  assert.ok(p.dropIns.length >= 1);
});

test("proposes a restart drop-in with requested policy", () => {
  const d = U.proposeRestartDropin({
    unit: "shop-api",
    restart: "always",
    restartSec: 5,
    startLimitIntervalSec: 0,
  });
  assert.equal(d.unit, "shop-api.service");
  assert.equal(d.files.length, 1);
  assert.ok(d.files[0].path.endsWith("10-unitwatch-restart.conf"));
  assert.match(d.files[0].content, /\[Service\]/);
  assert.match(d.files[0].content, /Restart=always/);
  assert.match(d.files[0].content, /RestartSec=5/);
  assert.match(d.files[0].content, /\[Unit\]/);
  assert.match(d.files[0].content, /StartLimitIntervalSec=0/);
});

test("proposes a TCP watchdog timer pair", () => {
  const w = U.proposeWatchdogTimer({
    unit: "shop-api.service",
    host: "127.0.0.1",
    port: 8080,
    intervalSec: 30,
  });
  assert.equal(w.files.length, 2);
  const names = w.files.map((f) => f.path).join("\n");
  assert.match(names, /unitwatch-port\.service$/m);
  assert.match(names, /unitwatch-port\.timer$/m);
  assert.match(w.files[0].content, /\/dev\/tcp\/127\.0\.0\.1\/8080/);
  assert.match(w.files[1].content, /OnUnitActiveSec=30/);
  assert.match(w.files[0].content, /systemctl restart "shop-api\.service"/);
});

test("rollback deletes the drop-in and watchdog units", () => {
  const r = U.proposeRollback({ unit: "shop-api.service" });
  assert.ok(r.filesToRemove.some((p) => p.includes("10-unitwatch-restart.conf")));
  assert.match(r.files[0].content, /systemctl disable --now/);
  assert.match(r.files[0].content, /rm -f "\$DROPIN"/);
});

test("hardening plan wires parse + drop-in + watchdog + rollback", () => {
  const plan = U.proposeHardeningPlan({
    statusBlob: U.SAMPLE_STATUS,
    restart: "always",
  });
  assert.equal(plan.unit, "shop-api.service");
  assert.equal(plan.parsed.result, "start-limit-hit");
  assert.equal(plan.files.length, 4);
  assert.equal(plan.port ?? 8080, 8080);
});

test("rejects path traversal in unit names", () => {
  assert.throws(() => U.sanitizeUnit("../evil.service"), /paths/);
  assert.throws(() => U.sanitizeUnit("foo/bar.service"), /paths/);
  assert.throws(() => U.sanitizeUnit("foo bar.service"), /paths/);
});

test("guesses 8080 from the sample blob", () => {
  const p = U.parseSystemdStatus(U.SAMPLE_STATUS);
  assert.equal(U.guessPort(p, {}), 8080);
});
