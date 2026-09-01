# Unitwatch

Live: https://webmcp-unitwatch.mbrush-ltd.workers.dev/

A public web bench for crashed systemd units. A human pastes systemctl status or a journal snippet. An agent calls WebMCP tools. Both see the same proposed files: a restart drop-in, a TCP watchdog timer, and a rollback.

WebMCP Challenge entry. Deadline 3 Sep 2026, 13:00 PDT.

**Cove / Solari Systems LLC**

## Why this is a WebMCP app

Operators already paste status dumps into chat windows. Agents then guess at unit files. Unitwatch makes the generators first-class tools on the page via `document.modelContext.registerTool`.

## Tools

- parse_systemd_status
- propose_restart_dropin
- propose_watchdog_timer
- propose_rollback
- propose_hardening_plan
- get_workspace

## License

MIT. See LICENSE.
