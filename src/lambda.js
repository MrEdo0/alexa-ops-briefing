/**
 * AWS Lambda handler for the Daily Ops Briefing MCP server.
 * Deploy as a Node.js 20 Lambda behind API Gateway/Function URL, which
 * satisfies the AWS Builder mini-challenge (Bedrock integration in
 * src/bedrock-insights.js is optional at demo time).
 *
 * Set env vars: S3_DATA_BUCKET (business.json location), optional BEDROCK_MODEL.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildBriefing } from "./server.js";
import { polishBriefing } from "./bedrock-insights.js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

async function loadBusinessData() {
  if (process.env.S3_DATA_BUCKET) {
    const resp = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_DATA_BUCKET, Key: "business.json" }));
    return JSON.parse(await resp.Body.transformToString("utf8"));
  }
  // local fallback for testing the Lambda shape
  const fs = await import("fs");
  return JSON.parse(fs.readFileSync(new URL("../data/business.json", import.meta.url), "utf8"));
}

export async function handler(event) {
  const server = new McpServer({ name: "daily-ops-briefing", version: "0.1.0" });

  server.tool("get_daily_briefing", "Today's spoken business briefing", {}, async () => {
    const data = await loadBusinessData();
    const briefing = buildBriefing(data);
    return { content: [{ type: "text", text: await polishBriefing(briefing) }] };
  });

  server.tool("get_revenue_summary", "Sales and revenue for the last 7 days", {}, async () => {
    const data = await loadBusinessData();
    const week = data.revenue.last_7_days;
    const units = week.reduce((s, r) => s + (r.sales || 0), 0);
    const revenue = week.reduce((s, r) => s + (r.amount || 0), 0);
    return { content: [{ type: "text", text: `Last 7 days: ${units} sales, ${data.business.currency} ${revenue}.` }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  // Adapt the API Gateway v2 event to a Node-style req/res for the SDK transport.
  const req = {
    method: event.requestContext?.http?.method || "POST",
    headers: new Headers(event.headers || {}),
    url: event.rawPath || "/mcp",
    body: typeof event.body === "string" ? event.body : JSON.stringify(event.body || {}),
  };

  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      setHeader(k, v) { this.headers[k] = v; },
      write(chunk) { this.body += chunk; },
      end(chunk) { if (chunk) this.body += chunk; resolve({ statusCode: this.statusCode, headers: this.headers, body: this.body }); },
    };
    transport.handleRequest(req, res, req.body ? JSON.parse(req.body) : undefined);
  });
}
