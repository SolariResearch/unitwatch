(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const files = {
    dropin: null,
    watchdog: null,
    rollback: null,
  };
  let parsed = null;
  let activity = [];
  let toolCatalog = [];

  function field(id) {
    const el = $(id);
    return el ? el.value : "";
  }

  function workspaceFromForm() {
    return {
      statusBlob: field("status-blob"),
      unit: field("unit-name"),
      restart: field("restart-policy") || "always",
      restartSec: Number(field("restart-sec") || 5),
      startLimitIntervalSec: Number(field("start-limit") || 0),
      host: field("watch-host") || "127.0.0.1",
      port: Number(field("watch-port") || 8080),
      intervalSec: Number(field("watch-interval") || 30),
    };
  }

  function getWorkspace() {
    const ws = workspaceFromForm();
    const shown = [];
    for (const key of ["dropin", "watchdog", "rollback"]) {
      if (files[key] && files[key].files) shown.push(...files[key].files);
    }
    return Object.assign({}, ws, {
      parsed: parsed
        ? {
            unit: parsed.unit,
            activeState: parsed.activeState,
            result: parsed.result,
            startLimitHit: parsed.startLimitHit,
            issues: parsed.issues,
            summary: parsed.summary,
          }
        : null,
      files: shown,
    });
  }

  function setWebmcpState(state, label) {
    const badge = $("webmcp-badge");
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = label;
  }

  function setToolCatalog(defs) {
    toolCatalog = defs || [];
    renderTools();
  }

  function logActivity(kind, name, detail) {
    const entry = {
      t: new Date().toISOString(),
      kind,
      name,
      detail:
        typeof detail === "string"
          ? detail
          : detail && detail.summary
            ? detail.summary
            : JSON.stringify(detail || {}, null, 0).slice(0, 280),
    };
    activity.unshift(entry);
    activity = activity.slice(0, 24);
    renderActivity();
  }

  function applyParse(blob, next) {
    parsed = next;
    if (blob && $("status-blob") && !$("status-blob").value.trim()) {
      $("status-blob").value = blob;
    } else if (blob && $("status-blob")) {
      $("status-blob").value = blob;
    }
    if (next && next.unit && $("unit-name")) {
      $("unit-name").value = next.unit;
    }
    const guessed = Unitwatch.guessPort(next, workspaceFromForm());
    if ($("watch-port") && guessed) $("watch-port").value = String(guessed);
    renderDiagnosis();
  }

  function applyFiles(kind, result) {
    files[kind] = result;
    if (result && result.unit && $("unit-name") && !$("unit-name").value.trim()) {
      $("unit-name").value = result.unit;
    }
    renderFiles();
  }

  function applyPlan(result) {
    if (result.parsed) {
      parsed = result.parsed;
      if (result.parsed.unit && $("unit-name")) $("unit-name").value = result.parsed.unit;
      renderDiagnosis();
    } else if (result.unit && $("unit-name")) {
      $("unit-name").value = result.unit;
    }
    files.dropin = {
      files: result.files.filter((f) => f.path.endsWith(".conf")),
      commands: result.commands,
      warnings: result.warnings,
      summary: result.summary,
      unit: result.unit,
    };
    files.watchdog = {
      files: result.files.filter(
        (f) => f.path.endsWith(".timer") || /unitwatch-port\.service$/.test(f.path)
      ),
      unit: result.unit,
    };
    files.rollback = {
      files: result.files.filter((f) => f.path.endsWith(".sh")),
      unit: result.unit,
    };
    renderFiles();
  }

  function severityClass(s) {
    if (s === "error") return "sev-error";
    if (s === "warn") return "sev-warn";
    return "sev-info";
  }

  function renderDiagnosis() {
    const root = $("diagnosis");
    if (!root) return;
    if (!parsed) {
      root.innerHTML =
        '<p class="empty">Paste a <code>systemctl status</code> blob or a unit name. People click the buttons. Agents call the tools. Same files land here.</p>';
      return;
    }
    const issues = (parsed.issues || [])
      .map(
        (i) =>
          `<li class="${severityClass(i.severity)}"><span class="code">${escapeHtml(
            i.code
          )}</span> ${escapeHtml(i.detail)}</li>`
      )
      .join("");
    root.innerHTML = `
      <div class="diag-grid">
        <div><span class="k">Unit</span><span class="v mono">${escapeHtml(
          parsed.unit || "—"
        )}</span></div>
        <div><span class="k">Active</span><span class="v">${escapeHtml(
          parsed.activeState || "—"
        )}${parsed.subState ? " (" + escapeHtml(parsed.subState) + ")" : ""}</span></div>
        <div><span class="k">Result</span><span class="v">${escapeHtml(
          parsed.result || "—"
        )}</span></div>
        <div><span class="k">Exit</span><span class="v">${escapeHtml(
          parsed.exitStatus || "—"
        )}</span></div>
        <div><span class="k">PID</span><span class="v">${escapeHtml(
          parsed.mainPid || "—"
        )}</span></div>
        <div><span class="k">Loaded</span><span class="v">${escapeHtml(
          parsed.loadState || "—"
        )}${parsed.enablement ? " / " + escapeHtml(parsed.enablement) : ""}</span></div>
      </div>
      <p class="summary">${escapeHtml(parsed.summary)}</p>
      <ul class="issues">${issues}</ul>
    `;
  }

  function renderFiles() {
    const root = $("files");
    if (!root) return;
    const blocks = [];
    for (const key of ["dropin", "watchdog", "rollback"]) {
      const bundle = files[key];
      if (!bundle || !bundle.files || !bundle.files.length) continue;
      for (const f of bundle.files) {
        blocks.push(fileCard(f, bundle.warnings));
      }
    }
    if (!blocks.length) {
      root.innerHTML =
        '<p class="empty">Proposed drop-in, watchdog units, and rollback appear here — for the human and for the agent.</p>';
      return;
    }
    root.innerHTML = blocks.join("");
    root.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pre = btn.parentElement.querySelector("pre");
        try {
          await navigator.clipboard.writeText(pre ? pre.textContent : "");
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        } catch (e) {
          btn.textContent = "Copy failed";
        }
      });
    });
    root.querySelectorAll("[data-dl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".file-card");
        const pre = card.querySelector("pre");
        const name = card.dataset.filename || "unitwatch.conf";
        const blob = new Blob([pre.textContent], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name.split("/").pop();
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });
  }

  function fileCard(file, warnings) {
    const warn =
      warnings && warnings.length
        ? `<ul class="warns">${warnings
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join("")}</ul>`
        : "";
    return `<article class="file-card" data-filename="${escapeHtml(file.path)}">
      <header>
        <h3 class="mono">${escapeHtml(file.path)}</h3>
        <div class="file-actions">
          <button type="button" class="ghost" data-copy>Copy</button>
          <button type="button" class="ghost" data-dl>Download</button>
        </div>
      </header>
      <pre><code>${escapeHtml(file.content)}</code></pre>
      ${warn}
    </article>`;
  }

  function renderActivity() {
    const root = $("activity");
    if (!root) return;
    if (!activity.length) {
      root.innerHTML = "<li class='muted'>No tool calls yet.</li>";
      return;
    }
    root.innerHTML = activity
      .map(
        (a) =>
          `<li class="act-${escapeHtml(a.kind)}"><span class="mono">${escapeHtml(
            a.name
          )}</span> <span class="kind">${escapeHtml(a.kind)}</span> ${escapeHtml(
            a.detail || ""
          )}</li>`
      )
      .join("");
  }

  function renderTools() {
    const root = $("tool-list");
    if (!root) return;
    const defs = toolCatalog.length
      ? toolCatalog
      : window.UnitwatchWebMCP
        ? UnitwatchWebMCP.TOOL_DEFS
        : [];
    root.innerHTML = defs
      .map(
        (t) =>
          `<li><span class="mono">${escapeHtml(t.name)}</span><span>${escapeHtml(
            t.title
          )}</span></li>`
      )
      .join("");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fail(err) {
    logActivity("err", "ui", err && err.message ? err.message : String(err));
    const note = $("form-error");
    if (note) {
      note.hidden = false;
      note.textContent = err && err.message ? err.message : String(err);
    }
  }

  function clearError() {
    const note = $("form-error");
    if (note) {
      note.hidden = true;
      note.textContent = "";
    }
  }

  function onParse() {
    clearError();
    try {
      const blob = field("status-blob") || Unitwatch.SAMPLE_STATUS;
      const p = Unitwatch.parseSystemdStatus(blob);
      applyParse(blob, p);
      logActivity("ok", "parse_systemd_status", p.summary);
    } catch (err) {
      fail(err);
    }
  }

  function onDropin() {
    clearError();
    try {
      const ws = workspaceFromForm();
      if (!ws.unit && field("status-blob")) {
        const p = Unitwatch.parseSystemdStatus(field("status-blob"));
        applyParse(field("status-blob"), p);
        ws.unit = p.unit;
      }
      const result = Unitwatch.proposeRestartDropin(ws);
      applyFiles("dropin", result);
      logActivity("ok", "propose_restart_dropin", result.summary);
    } catch (err) {
      fail(err);
    }
  }

  function onWatchdog() {
    clearError();
    try {
      const result = Unitwatch.proposeWatchdogTimer(workspaceFromForm());
      applyFiles("watchdog", result);
      logActivity("ok", "propose_watchdog_timer", result.summary);
    } catch (err) {
      fail(err);
    }
  }

  function onRollback() {
    clearError();
    try {
      const result = Unitwatch.proposeRollback(workspaceFromForm());
      applyFiles("rollback", result);
      logActivity("ok", "propose_rollback", result.summary);
    } catch (err) {
      fail(err);
    }
  }

  function onPlan() {
    clearError();
    try {
      const result = Unitwatch.proposeHardeningPlan(workspaceFromForm());
      applyPlan(result);
      logActivity("ok", "propose_hardening_plan", result.summary);
    } catch (err) {
      fail(err);
    }
  }

  function onSample() {
    $("status-blob").value = Unitwatch.SAMPLE_STATUS;
    onParse();
  }

  function bind() {
    $("btn-parse") && $("btn-parse").addEventListener("click", onParse);
    $("btn-dropin") && $("btn-dropin").addEventListener("click", onDropin);
    $("btn-watchdog") && $("btn-watchdog").addEventListener("click", onWatchdog);
    $("btn-rollback") && $("btn-rollback").addEventListener("click", onRollback);
    $("btn-plan") && $("btn-plan").addEventListener("click", onPlan);
    $("btn-sample") && $("btn-sample").addEventListener("click", onSample);
    renderDiagnosis();
    renderFiles();
    renderActivity();
    renderTools();
  }

  window.UnitwatchUI = {
    getWorkspace,
    applyParse,
    applyFiles,
    applyPlan,
    logActivity,
    setWebmcpState,
    setToolCatalog,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
