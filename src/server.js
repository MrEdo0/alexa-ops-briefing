/**
 * Daily Ops Briefing - Alexa+ Agent Skill (MCP server)
 * Amazon Developer Hackathon "Build, Ship, Shape" - Alexa+ track
 *
 * Implements the Model Context Protocol spec 2025-11-25 over Streamable HTTP,
 * the integration standard for Alexa+ brand experiences.
 *
 * Run locally:  npm install && npm start
 * The server listens on PORT (default 3000) at /mcp
 *
 * Optional: set BEDROCK_MODEL to have Amazon Bedrock polish the briefing
 * into an even more natural spoken script (falls back silently otherwise).
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { polishBriefing, bedrockEnabled } from "./bedrock-insights.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "data", "business.json");
const PORT = process.env.PORT || 3000;

const loadData = () => JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const saveData = (d) => fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));

/* ---------- Briefing logic (framework-agnostic, also used by Lambda) ---------- */

const spokenDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

export function buildBriefing(data = loadData(), today = new Date().toISOString().slice(0, 10)) {
  const firstName = (data.business.owner_name || "").split(" ")[0];
  const parts = [];

  const replied = data.leads.filter((l) => l.status === "replied");
  const dueFollowups = data.followups.filter((f) => !f.done && f.due <= today);
  const week = data.revenue.last_7_days;
  const units = week.reduce((s, r) => s + (r.sales || 0), 0);
  const revenue = week.reduce((s, r) => s + (r.amount || 0), 0);
  const best = data.products.reduce((a, b) => (a.copies_last_7_days >= b.copies_last_7_days ? a : b));

  // Opener
  parts.push(`Good morning${firstName ? `, ${firstName}` : ""}. Here's your business briefing for ${spokenDate(today)}.`);

  // 1. Leads that need attention
  if (replied.length) {
    const list = replied.map((l) => `${l.company}, ${l.last_event.toLowerCase()}`).join("; ");
    const first = replied[0];
    parts.push(
      `First, the leads that need you. ` +
        `${replied.length === 1 ? "One lead replied" : `${replied.length} leads replied`}: ${list}. ` +
        `The next step with ${first.company} is to ${first.next_step.toLowerCase()}, due ${first.next_step_due}.`
    );
  } else {
    parts.push("No new replies yet. The pitches are out, and the follow-ups will nudge them along.");
  }

  // 2. Follow-ups due today or overdue
  if (dueFollowups.length) {
    const list = dueFollowups.map((f) => f.what.toLowerCase()).join("; ");
    parts.push(
      `${dueFollowups.length === 1 ? "One follow-up is" : `${dueFollowups.length} follow-ups are`} due today: ${list}.`
    );
  } else {
    parts.push("You're all caught up on follow-ups. Nothing overdue.");
  }

  // 3. Revenue summary
  parts.push(
    `Over the last seven days you made ${units} sale${units === 1 ? "" : "s"} worth ${data.business.currency} ${revenue}. ` +
      (units > 0
        ? `Your best seller was the ${best.name}.`
        : `No product moved this week. A good moment to push that launch discount.`)
  );

  // 4. Top actions, ranked for voice
  const actions = [];
  if (replied.length) actions.push(`follow up with ${replied[0].company} to ${replied[0].next_step.toLowerCase()}`);
  if (dueFollowups.length) actions.push(dueFollowups[0].what.toLowerCase());
  actions.push("send the next batch of outreach emails this afternoon");

  const ranks = ["First", "Then", "Finally"];
  const ranked = actions.slice(0, 3).map((a, i) => `${ranks[i]}, ${a}`);
  parts.push(`So, your priorities for today: ${ranked.join(". ")}.`);
  parts.push("That's your briefing. Make it a good one.");

  return parts.join("\n\n");
}

/* ---------- MCP server ---------- */

function createServer() {
  const server = new McpServer({
    name: "daily-ops-briefing",
    version: "0.1.0",
    description: "Speaks a business owner's daily briefing: lead replies, follow-ups due, revenue summary, top actions.",
  });

  server.tool(
    "get_daily_briefing",
    "Get today's spoken business briefing: lead replies, follow-ups due, revenue summary and top 3 actions.",
    {},
    async () => {
      const briefing = buildBriefing();
      const polished = await polishBriefing(briefing);
      return { content: [{ type: "text", text: polished }] };
    }
  );

  server.tool(
    "get_leads",
    "List all sales leads with status and next steps.",
    {},
    async () => {
      const data = loadData();
      const text = data.leads
        .map((l) => `${l.company} (${l.contact}) - ${l.status}. Last event: ${l.last_event}. Next: ${l.next_step} due ${l.next_step_due}.`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_followups",
    "List follow-up tasks that are still open.",
    {},
    async () => {
      const data = loadData();
      const open = data.followups.filter((f) => !f.done);
      const text = open.length
        ? open.map((f) => `${f.due}: ${f.what}`).join("\n")
        : "No open follow-ups. You're all caught up.";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_revenue_summary",
    "Get sales and revenue for the last 7 days plus best-selling product.",
    {},
    async () => {
      const data = loadData();
      const week = data.revenue.last_7_days;
      const units = week.reduce((s, r) => s + (r.sales || 0), 0);
      const revenue = week.reduce((s, r) => s + (r.amount || 0), 0);
      const best = data.products.reduce((a, b) => (a.copies_last_7_days >= b.copies_last_7_days ? a : b));
      return {
        content: [{
          type: "text",
          text: `Last 7 days: ${units} sales, ${data.business.currency} ${revenue} revenue. Best seller: ${best.name} with ${best.copies_last_7_days} copies.`,
        }],
      };
    }
  );

  server.tool(
    "mark_followup_done",
    "Mark a follow-up task as done by its id.",
    { id: z.string().describe("The follow-up id, e.g. f1") },
    async ({ id }) => {
      const data = loadData();
      const f = data.followups.find((x) => x.id === id);
      if (!f) return { content: [{ type: "text", text: `No follow-up found with id ${id}.` }] };
      f.done = true;
      saveData(data);
      return { content: [{ type: "text", text: `Marked "${f.what}" as done. Well done.` }] };
    }
  );

  return server;
}

/* ---------- Streamable HTTP transport ---------- */

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// Health check for demos
app.get("/", (req, res) => {
  res.json({
    status: "Daily Ops Briefing MCP server running",
    tools: ["get_daily_briefing", "get_leads", "get_followups", "get_revenue_summary", "mark_followup_done"],
    bedrock_polish: bedrockEnabled() ? "enabled" : "disabled (template voice)",
  });
});

// Only start the HTTP listener when run directly (npm start), not when imported by the Lambda handler.
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined && isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Daily Ops Briefing MCP server on http://localhost:${PORT}/mcp`);
  });
}

export { createServer };
