/**
 * Register Unitwatch tools on document.modelContext (WebMCP).
 * Feature-detects the API so the page still works in ordinary browsers.
 */
(function () {
  "use strict";

  const TOOL_DEFS = [
    {
      name: "parse_systemd_status",
      title: "Parse systemd status",
      description:
        "Parse a pasted systemctl status or journalctl snippet. Extracts unit name, Active/Loaded state, result (exit-code, start-limit-hit, watchdog), PIDs, drop-ins, and issues. Use this first when the human pasted a blob. Does not contact any host.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          statusBlob: {
            type: "string",
            description:
              "Raw output of systemctl status UNIT or a journalctl snippet. If omitted, uses the blob currently in the page workspace.",
          },
        },
      },
      async execute(input) {
        const blob =
          (input && input.statusBlob) ||
          (window.UnitwatchUI && UnitwatchUI.getWorkspace().statusBlob) ||
          "";
        const parsed = Unitwatch.parseSystemdStatus(blob);
        if (window.UnitwatchUI) UnitwatchUI.applyParse(blob, parsed);
        return {
          ok: true,
          tool: "parse_systemd_status",
          summary: parsed.summary,
          unit: parsed.unit,
          activeState: parsed.activeState,
          subState: parsed.subState,
          result: parsed.result,
          startLimitHit: parsed.startLimitHit,
          exitStatus: parsed.exitStatus,
          issues: parsed.issues,
          dropIns: parsed.dropIns,
          logs: parsed.logs.slice(-8),
        };
      },
    },
    {
      name: "propose_restart_dropin",
      title: "Propose restart drop-in",
      description:
        "Generate a systemd drop-in that sets Restart=, RestartSec=, and StartLimitIntervalSec= for a unit. Default policy is Restart=always, RestartSec=5, StartLimitIntervalSec=0. Updates the files shown on the page. Does not install anything on a host.",
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          unit: {
            type: "string",
            description:
              "Unit name, with or without .service. Defaults to the parsed workspace unit.",
          },
          restart: {
            type: "string",
            enum: [
              "no",
              "on-success",
              "on-failure",
              "on-abnormal",
              "on-watchdog",
              "on-abort",
              "always",
            ],
            description: "systemd Restart= policy. Default always.",
          },
          restartSec: {
            type: "number",
            description: "RestartSec in seconds. Default 5.",
          },
          startLimitIntervalSec: {
            type: "number",
            description:
              "StartLimitIntervalSec in seconds. Default 0 (disable start limit).",
          },
          startLimitBurst: {
            type: "number",
            description: "StartLimitBurst. Default 0 when interval is 0.",
          },
        },
      },
      async execute(input) {
        const ws = window.UnitwatchUI ? UnitwatchUI.getWorkspace() : {};
        const result = Unitwatch.proposeRestartDropin({
          unit: (input && input.unit) || ws.unit,
          restart: (input && input.restart) || ws.restart,
          restartSec: input && input.restartSec != null ? input.restartSec : ws.restartSec,
          startLimitIntervalSec:
            input && input.startLimitIntervalSec != null
              ? input.startLimitIntervalSec
              : ws.startLimitIntervalSec,
          startLimitBurst: input && input.startLimitBurst,
        });
        if (window.UnitwatchUI) UnitwatchUI.applyFiles("dropin", result);
        return {
          ok: true,
          tool: "propose_restart_dropin",
          summary: result.summary,
          unit: result.unit,
          files: result.files,
          commands: result.commands,
          warnings: result.warnings,
        };
      },
    },
    {
      name: "propose_watchdog_timer",
      title: "Propose TCP watchdog timer",
      description:
        "Generate a systemd oneshot service plus timer that checks a TCP port (bash /dev/tcp) and restarts the target unit when the port is closed. Default host 127.0.0.1, port 8080, interval 30s. Updates the files shown on the page. Does not install anything on a host.",
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          unit: {
            type: "string",
            description: "Target unit to restart when the port is down.",
          },
          host: {
            type: "string",
            description: "TCP host to check. Default 127.0.0.1.",
          },
          port: {
            type: "number",
            description: "TCP port to check. Default 8080 or guessed from the status blob.",
          },
          intervalSec: {
            type: "number",
            description: "Timer interval in seconds. Default 30. Minimum 5.",
          },
        },
        required: [],
      },
      async execute(input) {
        const ws = window.UnitwatchUI ? UnitwatchUI.getWorkspace() : {};
        const result = Unitwatch.proposeWatchdogTimer({
          unit: (input && input.unit) || ws.unit,
          host: (input && input.host) || ws.host,
          port: input && input.port != null ? input.port : ws.port,
          intervalSec:
            input && input.intervalSec != null ? input.intervalSec : ws.intervalSec,
        });
        if (window.UnitwatchUI) UnitwatchUI.applyFiles("watchdog", result);
        return {
          ok: true,
          tool: "propose_watchdog_timer",
          summary: result.summary,
          unit: result.unit,
          host: result.host,
          port: result.port,
          files: result.files,
          commands: result.commands,
          warnings: result.warnings,
        };
      },
    },
    {
      name: "propose_rollback",
      title: "Propose rollback",
      description:
        "Generate a root shell script that deletes the Unitwatch restart drop-in and optionally disables/removes the TCP watchdog timer and service, then runs daemon-reload. Does not restart the unit. Updates the files shown on the page.",
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          unit: { type: "string", description: "Unit the drop-in belonged to." },
          includeWatchdog: {
            type: "boolean",
            description: "Also remove the TCP watchdog units. Default true.",
          },
        },
      },
      async execute(input) {
        const ws = window.UnitwatchUI ? UnitwatchUI.getWorkspace() : {};
        const result = Unitwatch.proposeRollback({
          unit: (input && input.unit) || ws.unit,
          includeWatchdog:
            input && input.includeWatchdog != null ? input.includeWatchdog : true,
        });
        if (window.UnitwatchUI) UnitwatchUI.applyFiles("rollback", result);
        return {
          ok: true,
          tool: "propose_rollback",
          summary: result.summary,
          unit: result.unit,
          files: result.files,
          filesToRemove: result.filesToRemove,
          commands: result.commands,
          warnings: result.warnings,
        };
      },
    },
    {
      name: "propose_hardening_plan",
      title: "Propose full hardening plan",
      description:
        "One-shot: parse the status blob if provided, then generate the restart drop-in, TCP watchdog timer, and rollback script together and show them on the page. Prefer this when the human wants a complete proposal. Does not install anything on a host.",
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          statusBlob: {
            type: "string",
            description: "Optional systemctl status / journal snippet to parse first.",
          },
          unit: { type: "string", description: "Override unit name." },
          restart: { type: "string", description: "Restart= policy. Default always." },
          host: { type: "string", description: "Watchdog host. Default 127.0.0.1." },
          port: { type: "number", description: "Watchdog TCP port." },
          intervalSec: { type: "number", description: "Watchdog interval seconds." },
          restartSec: { type: "number", description: "RestartSec seconds. Default 5." },
        },
      },
      async execute(input) {
        const ws = window.UnitwatchUI ? UnitwatchUI.getWorkspace() : {};
        const result = Unitwatch.proposeHardeningPlan({
          statusBlob: (input && input.statusBlob) || ws.statusBlob,
          unit: (input && input.unit) || ws.unit,
          restart: (input && input.restart) || ws.restart,
          host: (input && input.host) || ws.host,
          port: input && input.port != null ? input.port : ws.port,
          intervalSec:
            input && input.intervalSec != null ? input.intervalSec : ws.intervalSec,
          restartSec:
            input && input.restartSec != null ? input.restartSec : ws.restartSec,
        });
        if (window.UnitwatchUI) UnitwatchUI.applyPlan(result);
        return {
          ok: true,
          tool: "propose_hardening_plan",
          summary: result.summary,
          unit: result.unit,
          issues: result.issues,
          files: result.files,
          commands: result.commands,
          warnings: result.warnings,
        };
      },
    },
    {
      name: "get_workspace",
      title: "Get page workspace",
      description:
        "Read the current Unitwatch page workspace: pasted blob, unit name, Restart= policy, watchdog host/port, parsed diagnosis, and the files currently shown to the human. Call this to see what the person already entered before generating files.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const ws = window.UnitwatchUI
          ? UnitwatchUI.getWorkspace()
          : { error: "UI not mounted" };
        return {
          ok: true,
          tool: "get_workspace",
          summary: ws.unit
            ? `Workspace unit ${ws.unit}; ${ws.files ? ws.files.length : 0} files shown.`
            : "Workspace has no unit yet.",
          workspace: ws,
        };
      },
    },
  ];

  function modelContext() {
    const doc = document.modelContext;
    const nav = navigator.modelContext;
    if (doc && typeof doc.registerTool === "function") return doc;
    if (nav && typeof nav.registerTool === "function") return nav;
    return null;
  }

  function wrap(def) {
    const inner = def.execute;
    return async function execute(input, options) {
      if (options && options.signal && options.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (window.UnitwatchUI) UnitwatchUI.logActivity("call", def.name, input || {});
      try {
        const result = await inner(input || {}, options || {});
        if (window.UnitwatchUI) {
          UnitwatchUI.logActivity("ok", def.name, result.summary || def.name);
        }
        return result;
      } catch (err) {
        if (window.UnitwatchUI) {
          UnitwatchUI.logActivity("err", def.name, err && err.message);
        }
        return {
          ok: false,
          tool: def.name,
          error: err && err.message ? err.message : String(err),
        };
      }
    };
  }

  async function registerAll() {
    const ctx = modelContext();
    const names = TOOL_DEFS.map((t) => t.name);
    if (!ctx) {
      if (window.UnitwatchUI) {
        UnitwatchUI.setWebmcpState("off", "WebMCP not in this browser");
      }
      return { ok: false, reason: "no-modelContext", names };
    }
    const registered = [];
    const errors = [];
    for (const def of TOOL_DEFS) {
      try {
        await ctx.registerTool({
          name: def.name,
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: def.annotations,
          execute: wrap(def),
        });
        registered.push(def.name);
      } catch (err) {
        errors.push({ name: def.name, error: err && err.message });
      }
    }
    if (window.UnitwatchUI) {
      UnitwatchUI.setWebmcpState(
        registered.length ? "on" : "err",
        registered.length
          ? registered.length + " tools registered"
          : "registerTool failed"
      );
      UnitwatchUI.setToolCatalog(TOOL_DEFS);
    }
    return { ok: registered.length > 0, registered, errors, names };
  }

  window.UnitwatchWebMCP = {
    TOOL_DEFS,
    registerAll,
    modelContext,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      registerAll();
    });
  } else {
    registerAll();
  }
})();
