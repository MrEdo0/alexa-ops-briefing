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
 * Data source: data/business.json by default, or the business owner's own
 * Google Sheet (set GOOGLE_SHEET_ID + GOOGLE_API_KEY) so they just edit their
 * normal spreadsheet and Alexa knows.
 *
 * Optional: set BEDROCK_MODEL to have Amazon Bedrock polish the briefing
 * into an even more natural spoken script (falls back silently otherwise).
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { polishBriefing, bedrockEnabled } from "./bedrock-insights.js";
import { loadData, saveData, sheetsConfigured, sheetWrite, dataSource } from "./data-layer.js";

const PORT = process.env.PORT || 3000;

/* ---------- Briefing logic (framework-agnostic, also used by Lambda) ---------- */

const spokenDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

export function buildBriefing(data, today = new Date().toISOString().slice(0, 10)) {
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

/* ---------- Shared write helpers ---------- */

const todayISO = () => new Date().toISOString().slice(0, 10);

async function addFollowup(what, due) {
  const data = await loadData();
  const id = `f${data.followups.length + 1}`;
  const item = { id, what, due, done: false };
  data.followups.push(item);
  saveData(data);
  const synced = await sheetWrite("append", { tab: "Followups", row: [id, what, due, "FALSE"] });
  return {
    content: [{ type: "text", text: `Added "${what}" for ${due}.${synced ? " It's in your Sheet." : ""} I'll remind you when it's due.` }],
  };
}

async function logSale(product, amount, sales) {
  const data = await loadData();
  const date = todayISO();
  const existing = data.revenue.last_7_days.find((r) => r.date === date);
  if (existing) {
    existing.sales = (existing.sales || 0) + sales;
    existing.amount = (existing.amount || 0) + amount;
  } else {
    data.revenue.last_7_days.push({ date, sales, amount });
  }
  const prod = data.products.find((p) => p.name.toLowerCase() === product.toLowerCase());
  if (prod) prod.copies_last_7_days += sales;
  saveData(data);
  const synced = await sheetWrite("append", { tab: "Revenue", row: [date, sales, amount] });
  return {
    content: [{
      type: "text",
      text: `Logged ${sales} sale${sales === 1 ? "" : "s"} of the ${product} for ${data.business.currency} ${amount} today.${synced ? " Your Sheet is updated." : ""} Nice work.`,
    }],
  };
}

async function markFollowupDone(id) {
  const data = await loadData();
  const f = data.followups.find((x) => x.id === id);
  if (!f) return { content: [{ type: "text", text: `No follow-up found with id ${id}.` }] };
  f.done = true;
  saveData(data);
  await sheetWrite("mark_done", { id });
  return { content: [{ type: "text", text: `Marked "${f.what}" as done. Well done.` }] };
}

/* ---------- MCP server ---------- */

function createServer() {
  const server = new McpServer({
    name: "daily-ops-briefing",
    version: "0.2.0",
    description: "Speaks a business owner's daily briefing: lead replies, follow-ups due, revenue summary, top actions. Voice-first, data lives in the owner's own spreadsheet.",
  });

  server.tool(
    "get_daily_briefing",
    "Get today's spoken business briefing: lead replies, follow-ups due, revenue summary and top 3 actions.",
    {},
    async () => {
      const data = await loadData();
      const briefing = buildBriefing(data);
      const polished = await polishBriefing(briefing);
      return { content: [{ type: "text", text: polished }] };
    }
  );

  server.tool(
    "get_leads",
    "List all sales leads with status and next steps.",
    {},
    async () => {
      const data = await loadData();
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
      const data = await loadData();
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
      const data = await loadData();
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
    async ({ id }) => markFollowupDone(id)
  );

  server.tool(
    "add_followup",
    "Add a new follow-up task to today's plan, by voice.",
    {
      what: z.string().describe("What needs to be done, e.g. 'Send Mala the Brand the revised pitch'"),
      due: z.string().optional().describe("Due date, YYYY-MM-DD. Defaults to today."),
    },
    async ({ what, due }) => addFollowup(what, due || todayISO())
  );

  server.tool(
    "log_sale",
    "Log a sale that just happened, by voice, so the weekly revenue summary stays current.",
    {
      product: z.string().describe("Product name as it appears in the product list"),
      amount: z.number().describe("Sale amount in the business currency"),
      sales: z.number().optional().describe("Units sold, defaults to 1"),
    },
    async ({ product, amount, sales }) => logSale(product, amount, sales || 1)
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
    data_source: dataSource(),
    tools: [
      "get_daily_briefing",
      "get_leads",
      "get_followups",
      "get_revenue_summary",
      "mark_followup_done",
      "add_followup",
      "log_sale",
    ],
    bedrock_polish: bedrockEnabled() ? "enabled" : "disabled (template voice)",
  });
});

// Only start the HTTP listener when run directly (npm start), not when imported by the Lambda handler.
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined && isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Daily Ops Briefing MCP server on http://localhost:${PORT}/mcp`);
    console.log(`Data source: ${dataSource()}`);
  });
}

export { createServer };
