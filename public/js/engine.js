/**
 * Unitwatch engine — parse systemd status/journal blobs and generate
 * restart drop-ins, TCP watchdog timer units, and rollback scripts.
 * Pure functions. No network. Nothing is executed on a host.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.Unitwatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const UNIT_SUFFIX =
    "(?:service|socket|timer|target|path|mount|scope|device|slice|swap)";
  const UNIT_TOKEN = `[A-Za-z0-9_@.:\\\\-]+\\.${UNIT_SUFFIX}`;
  const UNIT_FIND = new RegExp(`(${UNIT_TOKEN})`);
  const UNIT_FULL = new RegExp(`^(${UNIT_TOKEN})$`);
  const UNIT_BARE = /^[A-Za-z0-9_@.:\\-]+$/;

  const RESTART_POLICIES = [
    "no",
    "on-success",
    "on-failure",
    "on-abnormal",
    "on-watchdog",
    "on-abort",
    "always",
  ];

  const SAMPLE_STATUS = `× shop-api.service - Shop API (node)
     Loaded: loaded (/etc/systemd/system/shop-api.service; enabled; preset: enabled)
     Active: failed (Result: start-limit-hit) since Mon 2026-08-31 17:41:08 CDT; 12min ago
    Process: 18421 ExecStart=/usr/bin/node /opt/shop-api/server.js (code=exited, status=1/FAILURE)
   Main PID: 18421 (code=exited, status=1/FAILURE)
        CPU: 412ms
     Status: "listening on :8080" (last)

Aug 31 17:41:02 n0 node[18421]: Error: listen EADDRINUSE: address already in use :::8080
Aug 31 17:41:02 n0 systemd[1]: shop-api.service: Main process exited, code=exited, status=1/FAILURE
Aug 31 17:41:02 n0 systemd[1]: shop-api.service: Failed with result 'exit-code'.
Aug 31 17:41:03 n0 systemd[1]: shop-api.service: Scheduled restart job, restart counter is at 5.
Aug 31 17:41:08 n0 systemd[1]: shop-api.service: Start request repeated too quickly.
Aug 31 17:41:08 n0 systemd[1]: shop-api.service: Failed with result 'start-limit-hit'.
Aug 31 17:41:08 n0 systemd[1]: Failed to start shop-api.service - Shop API (node).`;

  const SAMPLE_JOURNAL = `Aug 31 18:02:11 n0 systemd[1]: nginx.service: Current command vanished from the unit file, execution of the command list won't be resumed.
Aug 31 18:10:44 n0 nginx[992]: 2026/08/31 18:10:44 [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)
Aug 31 18:10:44 n0 systemd[1]: nginx.service: Main process exited, code=exited, status=1/FAILURE
Aug 31 18:10:44 n0 systemd[1]: nginx.service: Failed with result 'exit-code'.`;

  function trimText(value) {
    return String(value == null ? "" : value).replace(/\r\n/g, "\n").trim();
  }

  function sanitizeUnit(raw, opts) {
    const options = opts || {};
    let s = trimText(raw);
    if (!s) {
      if (options.optional) return "";
      throw new Error("Unit name is required.");
    }
    // Strip wrapping quotes and systemd bullet prefixes.
    s = s.replace(/^["'`]+|["'`]+$/g, "");
    s = s.replace(/^[\s●○×*●-]+/, "");
    if (s.includes("..") || s.includes("/") || s.includes("\\") || /\s/.test(s)) {
      throw new Error("Unit name may not contain paths, spaces, or parent segments.");
    }
    if (!UNIT_BARE.test(s)) {
      throw new Error("Unit name may only use letters, digits, and _ @ . : -");
    }
    if (!new RegExp(`\\.${UNIT_SUFFIX}$`).test(s)) {
      s += ".service";
    }
    if (!UNIT_FULL.test(s) || s.length > 256) {
      throw new Error("Unit name is not a valid systemd unit.");
    }
    return s;
  }

  function sanitizeHost(raw) {
    const s = trimText(raw) || "127.0.0.1";
    if (s.length > 253) throw new Error("Host is too long.");
    if (!/^[A-Za-z0-9.:-]+$/.test(s) || s.includes("..")) {
      throw new Error("Host may only be an IPv4/IPv6 address or DNS label.");
    }
    return s;
  }

  function sanitizePort(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error("Port must be an integer from 1 to 65535.");
    }
    return n;
  }

  function sanitizeRestart(raw) {
    const s = trimText(raw) || "always";
    if (!RESTART_POLICIES.includes(s)) {
      throw new Error(
        "Restart= must be one of: " + RESTART_POLICIES.join(", ")
      );
    }
    return s;
  }

  function sanitizeSeconds(raw, fallback, label) {
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 86400) {
      throw new Error(label + " must be between 0 and 86400 seconds.");
    }
    return n;
  }

  function unitStem(unit) {
    return unit.replace(/\.(service|socket|timer|target|path|mount|scope)$/, "");
  }

  function dropinDir(unit) {
    return "/etc/systemd/system/" + unit + ".d";
  }

  function dropinPath(unit) {
    return dropinDir(unit) + "/10-unitwatch-restart.conf";
  }

  function watchdogServiceName(unit) {
    return unitStem(unit) + "-unitwatch-port.service";
  }

  function watchdogTimerName(unit) {
    return unitStem(unit) + "-unitwatch-port.timer";
  }

  function firstMatch(text, re) {
    const m = text.match(re);
    return m ? m[1] : "";
  }

  function collectIssues(parsed) {
    const issues = [];
    if (parsed.notFound) {
      issues.push({
        code: "not-found",
        severity: "error",
        detail: "Unit file was not found on the host that produced this blob.",
      });
    }
    if (parsed.masked) {
      issues.push({
        code: "masked",
        severity: "error",
        detail: "Unit is masked; a drop-in will not start it until unmasked.",
      });
    }
    if (parsed.result === "start-limit-hit" || parsed.startLimitHit) {
      issues.push({
        code: "start-limit-hit",
        severity: "error",
        detail:
          "systemd stopped restarting because the start limit was hit. A drop-in with StartLimitIntervalSec=0 (and a RestartSec delay) is the usual fix.",
      });
    }
    if (parsed.result === "exit-code" || parsed.exitStatus) {
      issues.push({
        code: "exit-code",
        severity: "warn",
        detail:
          "Main process exited with status " +
          (parsed.exitStatus || "unknown") +
          ". Restart= will respawn it; it will not fix the crash itself.",
      });
    }
    if (parsed.result === "timeout" || parsed.result === "watchdog") {
      issues.push({
        code: parsed.result,
        severity: "warn",
        detail:
          "Unit failed a watchdog or start timeout. Pair Restart= with a TCP port check if the process stays up but stops answering.",
      });
    }
    if (parsed.activeState === "activating" && /auto-restart/i.test(parsed.subState)) {
      issues.push({
        code: "crash-loop",
        severity: "warn",
        detail: "Unit is in auto-restart. Confirm RestartSec is not 0.",
      });
    }
    if (/EADDRINUSE|address already in use/i.test(parsed.raw)) {
      issues.push({
        code: "addr-in-use",
        severity: "warn",
        detail:
          "Logs show a bind/address-in-use error. A restart policy will loop until the colliding process is gone; the TCP watchdog should target the intended port.",
      });
    }
    if (parsed.activeState === "failed" && issues.length === 0) {
      issues.push({
        code: "failed",
        severity: "error",
        detail: "Unit is failed. Propose a restart drop-in and review the journal.",
      });
    }
    if (parsed.activeState === "active" && parsed.subState === "running") {
      issues.push({
        code: "healthy",
        severity: "info",
        detail:
          "Unit is active (running). A drop-in still helps the next crash; a TCP watchdog catches 'alive but not listening'.",
      });
    }
    return issues;
  }

  function parseSystemdStatus(blob) {
    const raw = trimText(blob);
    if (!raw) {
      throw new Error("Paste a systemctl status or journalctl snippet first.");
    }
    if (raw.length > 200000) {
      throw new Error("Status blob is too large (200 KB max).");
    }

    const lines = raw.split("\n");
    const parsed = {
      kind: "unknown",
      unit: "",
      description: "",
      loadState: "",
      fragmentPath: "",
      enablement: "",
      dropIns: [],
      activeState: "",
      subState: "",
      activeSince: "",
      result: "",
      mainPid: "",
      execStart: "",
      exitStatus: "",
      nRestarts: "",
      docs: [],
      logs: [],
      startLimitHit: false,
      notFound: false,
      masked: false,
      raw,
      issues: [],
      summary: "",
    };

    const looksLikeStatus = /Loaded:|Active:|Main PID:|Drop-In:/i.test(raw);
    parsed.kind = looksLikeStatus ? "status" : "journal";

    for (const line of lines) {
      const t = line.replace(/\u00a0/g, " ");
      const trimmed = t.trim();

      if (!parsed.unit) {
        const head = trimmed.match(
          new RegExp(
            `^[●○×*●\\-]?\\s*(${UNIT_TOKEN})(?:\\s+-\\s+(.*))?$`
          )
        );
        if (head) {
          parsed.unit = head[1];
          parsed.description = (head[2] || "").trim();
        }
      }

      const loaded = trimmed.match(
        /^Loaded:\s+(\S+)(?:\s+\((.*)\))?/
      );
      if (loaded) {
        parsed.loadState = loaded[1];
        const inner = loaded[2] || "";
        parsed.notFound = /not-found|not found/i.test(inner) || parsed.loadState === "not-found";
        parsed.masked = parsed.loadState === "masked" || /masked/i.test(inner);
        const path = inner.match(/(\/[^;)]+\.(?:service|socket|timer|target|path))/);
        if (path) parsed.fragmentPath = path[1];
        const en = inner.match(/;\s*(enabled|disabled|static|indirect|alias|generated|enabled-runtime|disabled-runtime|masked)/i);
        if (en) parsed.enablement = en[1].toLowerCase();
      }

      if (/^Drop-In:/i.test(trimmed)) {
        const p = trimmed.match(/(\/[^ ]+)/);
        if (p) parsed.dropIns.push(p[1]);
      }
      if (/└─|└──|`-/.test(trimmed) && /\.conf$/.test(trimmed)) {
        const name = trimmed.replace(/^.*[─`-]\s*/, "");
        if (name) parsed.dropIns.push(name);
      }

      const active = trimmed.match(
        /^Active:\s+(\S+)(?:\s+\(([^)]*)\))?(?:\s+since\s+(.+))?/i
      );
      if (active) {
        parsed.activeState = active[1].toLowerCase();
        parsed.subState = (active[2] || "").trim();
        parsed.activeSince = (active[3] || "").trim();
        const res = parsed.subState.match(/Result:\s*([a-z0-9-]+)/i);
        if (res) parsed.result = res[1].toLowerCase();
      }

      const mainPid = trimmed.match(/^Main PID:\s+(\S+)(?:\s+\((.*)\))?/i);
      if (mainPid) {
        parsed.mainPid = mainPid[1];
        const ex = (mainPid[2] || "").match(/status=(\d+)/);
        if (ex) parsed.exitStatus = ex[1];
      }

      const proc = trimmed.match(/^Process:\s+\d+\s+(.*)/i);
      if (proc) {
        parsed.execStart = proc[1];
        const ex = proc[1].match(/status=(\d+)/);
        if (ex) parsed.exitStatus = parsed.exitStatus || ex[1];
      }

      const nre = trimmed.match(/^(?:NRestarts|Restart):\s+(\d+)/i);
      if (nre) parsed.nRestarts = nre[1];

      const counter = trimmed.match(/restart counter is at\s+(\d+)/i);
      if (counter) parsed.nRestarts = parsed.nRestarts || counter[1];

      if (/^Docs:/i.test(trimmed)) {
        parsed.docs.push(trimmed.replace(/^Docs:\s*/i, ""));
      }

      if (
        /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+/.test(trimmed) ||
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(trimmed)
      ) {
        parsed.logs.push(trimmed);
      }
    }

    if (!parsed.unit) {
      const found = raw.match(UNIT_FIND);
      if (found) parsed.unit = found[1];
    }

    if (/start-limit-hit|Start request repeated too quickly/i.test(raw)) {
      parsed.startLimitHit = true;
      if (!parsed.result) parsed.result = "start-limit-hit";
    }
    if (!parsed.result) {
      const r = raw.match(/Failed with result '([a-z0-9-]+)'/i);
      if (r) parsed.result = r[1].toLowerCase();
    }
    if (!parsed.exitStatus) {
      const st = raw.match(/status=(\d+)/);
      if (st) parsed.exitStatus = st[1];
    }
    if (!parsed.activeState && /Failed to start/i.test(raw)) {
      parsed.activeState = "failed";
    }

    parsed.issues = collectIssues(parsed);

    const bits = [];
    if (parsed.unit) bits.push(parsed.unit);
    else bits.push("unknown unit");
    if (parsed.activeState) {
      bits.push(
        "is " +
          parsed.activeState +
          (parsed.subState ? " (" + parsed.subState + ")" : "")
      );
    } else if (parsed.kind === "journal") {
      bits.push("appears in a journal snippet");
    }
    if (parsed.result) bits.push("result=" + parsed.result);
    if (parsed.startLimitHit) bits.push("start-limit-hit");
    parsed.summary = bits.join(" — ");

    return parsed;
  }

  function proposeRestartDropin(input) {
    const unit = sanitizeUnit(input && input.unit);
    const restart = sanitizeRestart(input && input.restart);
    const restartSec = sanitizeSeconds(
      input && input.restartSec,
      5,
      "RestartSec"
    );
    const startLimitIntervalSec = sanitizeSeconds(
      input && input.startLimitIntervalSec,
      0,
      "StartLimitIntervalSec"
    );
    const startLimitBurst = sanitizeSeconds(
      input && input.startLimitBurst,
      startLimitIntervalSec === 0 ? 0 : 5,
      "StartLimitBurst"
    );

    const path = dropinPath(unit);
    const content =
      `# ${path}\n` +
      `# Generated by Unitwatch. Review before installing. Does not run itself.\n` +
      `# Apply:\n` +
      `#   sudo mkdir -p ${dropinDir(unit)}\n` +
      `#   sudo tee ${path} < this-file\n` +
      `#   sudo systemctl daemon-reload\n` +
      `#   sudo systemctl restart ${unit}\n` +
      `\n` +
      `[Unit]\n` +
      `# 0 disables the start-limit window so crash-loops can recover after RestartSec.\n` +
      `StartLimitIntervalSec=${startLimitIntervalSec}\n` +
      `StartLimitBurst=${startLimitBurst}\n` +
      `\n` +
      `[Service]\n` +
      `Restart=${restart}\n` +
      `RestartSec=${restartSec}\n`;

    const commands = [
      `sudo mkdir -p ${dropinDir(unit)}`,
      `sudo tee ${path} >/dev/null <<'EOF'\n${content.trimEnd()}\nEOF`,
      `sudo systemctl daemon-reload`,
      `sudo systemctl restart ${unit}`,
      `systemctl status ${unit} --no-pager`,
    ];

    const warnings = [];
    if (restart === "always" && restartSec < 1) {
      warnings.push(
        "RestartSec under 1s with Restart=always can hammer the machine. Prefer 5s."
      );
    }
    if (startLimitIntervalSec === 0) {
      warnings.push(
        "StartLimitIntervalSec=0 removes systemd's restart brake. Pair it with RestartSec>=5."
      );
    }

    return {
      ok: true,
      unit,
      files: [{ path, content }],
      commands,
      warnings,
      summary:
        `Drop-in for ${unit}: Restart=${restart}, RestartSec=${restartSec}, ` +
        `StartLimitIntervalSec=${startLimitIntervalSec}.`,
    };
  }

  function proposeWatchdogTimer(input) {
    const unit = sanitizeUnit(input && input.unit);
    const host = sanitizeHost(input && input.host);
    const port = sanitizePort(input && (input.port != null ? input.port : 8080));
    const intervalSec = sanitizeSeconds(
      input && input.intervalSec,
      30,
      "intervalSec"
    );
    const interval = Math.max(5, intervalSec);
    const svc = watchdogServiceName(unit);
    const timer = watchdogTimerName(unit);
    const tcpLiteral = host.includes(":")
      ? `echo >/dev/tcp/[${host}]/${port}`
      : `echo >/dev/tcp/${host}/${port}`;

    const serviceContent =
      `# /etc/systemd/system/${svc}\n` +
      `# Unitwatch TCP watchdog for ${unit} → ${host}:${port}\n` +
      `# oneshot: if the port is closed, restart the target unit and fail this check.\n` +
      `\n` +
      `[Unit]\n` +
      `Description=Unitwatch TCP check ${host}:${port} for ${unit}\n` +
      `After=network-online.target ${unit}\n` +
      `Wants=network-online.target\n` +
      `\n` +
      `[Service]\n` +
      `Type=oneshot\n` +
      `TimeoutStartSec=10\n` +
      `# bash /dev/tcp is the check; systemctl restart only runs when the check fails.\n` +
      `ExecStart=/bin/bash -c 'if timeout 3 bash -c ${JSON.stringify(
        tcpLiteral
      )}; then exit 0; fi; systemctl restart ${JSON.stringify(
        unit
      )} ; exit 1'\n`;

    const timerContent =
      `# /etc/systemd/system/${timer}\n` +
      `# Poll ${host}:${port} every ${interval}s. Does not replace native WatchdogSec=.\n` +
      `\n` +
      `[Unit]\n` +
      `Description=Unitwatch TCP watchdog timer for ${unit}\n` +
      `\n` +
      `[Timer]\n` +
      `OnBootSec=${interval}\n` +
      `OnUnitActiveSec=${interval}\n` +
      `AccuracySec=1s\n` +
      `Persistent=true\n` +
      `Unit=${svc}\n` +
      `\n` +
      `[Install]\n` +
      `WantedBy=timers.target\n`;

    const files = [
      { path: `/etc/systemd/system/${svc}`, content: serviceContent },
      { path: `/etc/systemd/system/${timer}`, content: timerContent },
    ];

    const commands = [
      `sudo tee /etc/systemd/system/${svc} >/dev/null <<'EOF'\n${serviceContent.trimEnd()}\nEOF`,
      `sudo tee /etc/systemd/system/${timer} >/dev/null <<'EOF'\n${timerContent.trimEnd()}\nEOF`,
      `sudo systemctl daemon-reload`,
      `sudo systemctl enable --now ${timer}`,
      `systemctl list-timers ${timer} --no-pager`,
    ];

    return {
      ok: true,
      unit,
      host,
      port,
      intervalSec: interval,
      files,
      commands,
      warnings: [
        "The watchdog restarts the unit when the TCP port is closed. It will not fix a process that binds the port and then deadlocks on a different socket.",
        "Requires bash with /dev/tcp enabled (default on most Linux distros).",
      ],
      summary: `Watchdog timer ${timer} checks ${host}:${port} every ${interval}s and restarts ${unit} on failure.`,
    };
  }

  function proposeRollback(input) {
    const unit = sanitizeUnit(input && input.unit);
    const includeWatchdog =
      input && input.includeWatchdog === false ? false : true;
    const dropin = dropinPath(unit);
    const dir = dropinDir(unit);
    const svc = watchdogServiceName(unit);
    const timer = watchdogTimerName(unit);

    const filesToRemove = [dropin];
    if (includeWatchdog) {
      filesToRemove.push(`/etc/systemd/system/${svc}`);
      filesToRemove.push(`/etc/systemd/system/${timer}`);
    }

    const lines = [
      "#!/bin/bash",
      "# Unitwatch rollback — deletes generated drop-in" +
        (includeWatchdog ? " and TCP watchdog units" : "") +
        ".",
      "# Review, then: sudo bash this-script",
      "set -euo pipefail",
      `UNIT=${JSON.stringify(unit)}`,
      `DROPIN=${JSON.stringify(dropin)}`,
      `DROPDIR=${JSON.stringify(dir)}`,
      `if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)."; exit 1; fi`,
      `rm -f "$DROPIN"`,
      `rmdir "$DROPDIR" 2>/dev/null || true`,
    ];
    if (includeWatchdog) {
      lines.push(`systemctl disable --now ${JSON.stringify(timer)} 2>/dev/null || true`);
      lines.push(`rm -f /etc/systemd/system/${svc} /etc/systemd/system/${timer}`);
    }
    lines.push("systemctl daemon-reload");
    lines.push("# Intentionally does not restart $UNIT. Start it yourself if needed:");
    lines.push(`# systemctl restart "$UNIT"`);
    lines.push(`echo "Unitwatch rollback complete for $UNIT"`);
    lines.push("");

    const content = lines.join("\n");
    const path = `/root/unitwatch-rollback-${unitStem(unit)}.sh`;

    return {
      ok: true,
      unit,
      includeWatchdog,
      files: [{ path, content }],
      filesToRemove,
      commands: [
        "sudo bash " + path,
        `systemctl status ${unit} --no-pager`,
      ],
      warnings: [
        "Rollback deletes Unitwatch files only. It will not restore a drop-in you wrote by hand under a different name.",
        "The script does not restart the unit after deletion.",
      ],
      summary:
        `Rollback for ${unit}: delete ${dropin}` +
        (includeWatchdog ? ` and disable ${timer}.` : "."),
    };
  }

  function proposeHardeningPlan(input) {
    const blob = trimText(input && input.statusBlob);
    let parsed = null;
    let unit;
    if (blob) {
      parsed = parseSystemdStatus(blob);
      unit = sanitizeUnit((input && input.unit) || parsed.unit);
    } else {
      unit = sanitizeUnit(input && input.unit);
    }
    const port =
      input && input.port != null && input.port !== ""
        ? sanitizePort(input.port)
        : guessPort(parsed, input);
    const host = sanitizeHost((input && input.host) || "127.0.0.1");
    const restart = sanitizeRestart((input && input.restart) || "always");

    const dropin = proposeRestartDropin({
      unit,
      restart,
      restartSec: input && input.restartSec,
      startLimitIntervalSec: input && input.startLimitIntervalSec,
      startLimitBurst: input && input.startLimitBurst,
    });
    const watchdog = proposeWatchdogTimer({
      unit,
      host,
      port,
      intervalSec: input && input.intervalSec,
    });
    const rollback = proposeRollback({ unit, includeWatchdog: true });

    const files = dropin.files.concat(watchdog.files, rollback.files);
    const warnings = []
      .concat(dropin.warnings, watchdog.warnings, rollback.warnings)
      .filter(Boolean);
    const issues = parsed ? parsed.issues : [];

    return {
      ok: true,
      unit,
      parsed,
      files,
      commands: dropin.commands.concat(watchdog.commands),
      rollbackCommands: rollback.commands,
      warnings,
      issues,
      summary:
        (parsed ? parsed.summary + ". " : "") +
        `Plan: drop-in ${dropin.files[0].path}, watchdog ${host}:${port}, rollback script ${rollback.files[0].path}.`,
    };
  }

  function guessPort(parsed, input) {
    if (input && input.port) return sanitizePort(input.port);
    const text = ((parsed && parsed.raw) || "") + " " + ((parsed && parsed.execStart) || "");
    const patterns = [
      /listening on :(\d{2,5})\b/i,
      /EADDRINUSE:[^\n]*:(\d{2,5})\b/i,
      /bind\(\) to [\d.]+:(\d{2,5})\b/i,
      /0\.0\.0\.0:(\d{2,5})\b/,
      /\[::\]:(\d{2,5})\b/,
      /:::(\d{2,5})\b/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 65535) return n;
      }
    }
    return 8080;
  }

  return {
    SAMPLE_STATUS,
    SAMPLE_JOURNAL,
    RESTART_POLICIES,
    sanitizeUnit,
    sanitizeHost,
    sanitizePort,
    sanitizeRestart,
    parseSystemdStatus,
    proposeRestartDropin,
    proposeWatchdogTimer,
    proposeRollback,
    proposeHardeningPlan,
    dropinPath,
    watchdogServiceName,
    watchdogTimerName,
    guessPort,
  };
});
