const TOOLS = [
  "parse_systemd_status",
  "propose_restart_dropin",
  "propose_watchdog_timer",
  "propose_rollback",
  "propose_hardening_plan",
  "get_workspace",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        name: "unitwatch",
        product: "Unitwatch",
        org: "Solari Systems LLC",
        webmcp: "document.modelContext.registerTool",
        tools: TOOLS,
      });
    }
    if (url.pathname === "/api/tools") {
      return Response.json({
        note: "Tools execute in the browser via WebMCP, not over this HTTP API.",
        register: "document.modelContext.registerTool",
        tools: TOOLS,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
