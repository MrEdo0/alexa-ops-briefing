# Daily Ops Briefing

**An Alexa+ Agent Skill (MCP server) that speaks a business owner's daily priorities: lead replies, follow-ups due, revenue, and the top 3 actions for the day.**

Built for the **Amazon Developer Hackathon: Build, Ship, Shape** — Alexa+ track. A busy founder says *"Alexa, what's my business briefing?"* and gets a 30-second spoken summary of everything that needs their attention, generated live from their sales pipeline data.

## Why it matters

Small business owners drown in dashboards. They don't want to open five tabs before breakfast; they want the answer in the time it takes to make coffee. Daily Ops Briefing turns a CRM-style dataset into a conversational, voice-first morning ritual.

## Architecture

```
Alexa+  ──(MCP over Streamable HTTP, spec 2025-11-25)──>  Daily Ops Briefing MCP server
                                                                │
                        ┌───────────────────────────────────────┤
                        │                                       │
                Local data layer (business.json)      AWS deployment target
                        │                                       │
                src/server.js                      src/lambda.js (Lambda + S3)
                                                                │
                                                src/bedrock-insights.js (Bedrock,
                                                optional narrative polish)
```

The MCP server exposes 5 tools:

| Tool | What it does |
|---|---|
| `get_daily_briefing` | Full spoken briefing: replies, follow-ups, revenue, top 3 actions |
| `get_leads` | Every lead with status and next step |
| `get_followups` | Open follow-up tasks |
| `get_revenue_summary` | 7-day sales, revenue, best seller |
| `mark_followup_done` | Closes a follow-up by id |

## Run locally

```bash
npm install
npm start          # MCP server at http://localhost:3000/mcp
npm run demo       # prints the spoken briefing demo
```

Optional Bedrock voice polish: set `BEDROCK_MODEL` (e.g. `amazon.nova-lite-v1:0`)
and the briefing is rewritten into a tighter spoken script by Amazon Bedrock
via the Converse API (`src/bedrock-insights.js`). If the env var is missing or
the call fails, the skill silently falls back to the deterministic template
voice — it always speaks.

Test with any MCP client (Claude Desktop, MCP Inspector, or curl):

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_daily_briefing","arguments":{}}}'
```

## AWS deployment (AWS Builder mini-challenge)

The same server ships as a Lambda handler (`src/lambda.js`) behind a Function URL or API Gateway:

1. Upload `business.json` to S3 (`aws s3 cp data/business.json s3://YOUR-BUCKET/`).
2. Deploy: set env `S3_DATA_BUCKET=YOUR-BUCKET`, runtime Node.js 20, handler `src/lambda.handler`.
3. Point the MCP Streamable HTTP endpoint at the Function URL.
4. Optional: set `BEDROCK_MODEL` to enable Bedrock voice polish (Lambda needs the `bedrock:InvokeModel` permission).

## Track requirements checklist

- Self-hosted MCP server, Streamable HTTP transport: `src/server.js`
- Working demo: `npm run demo`
- Source code + run instructions: this repo
- AWS services used: Lambda, S3 (data), Amazon Bedrock (optional insight polish) — qualifies for the AWS Builder mini-challenge

## Product feedback (draft for the Devpost submission form)

What worked: the MCP-over-HTTP spec made Alexa+ integration feel like building any modern API — no custom skill vocabulary, just tools that a voice agent can call. The Streamable HTTP transport also means the exact same server runs locally, in a Lambda, or anywhere with a URL.

What needs work: the Alexa+ brand-experience onboarding still has gaps between "MCP server exists" and "Alexa reliably invokes it" — better local emulators for testing the voice round-trip would save real time.

Onboarding friction: provisioning the AWS side (Lambda + API Gateway + Bedrock IAM roles) took longer than writing the skill logic itself.

Would we build with it again: yes. The moment the briefing spoke back in a natural voice, the value of voice-first ops was obvious — it turns a dashboard chore into a 30-second morning habit.
