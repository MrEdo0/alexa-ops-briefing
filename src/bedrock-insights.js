/**
 * Optional Amazon Bedrock integration for Daily Ops Briefing.
 *
 * When BEDROCK_MODEL is set (e.g. "amazon.nova-lite-v1:0" or an Anthropic
 * Claude model id) and AWS credentials are available, the deterministic
 * briefing is rewritten by Bedrock into a tighter, more natural spoken
 * script for voice delivery.
 *
 * If the env var is missing, the SDK isn't installed, or the call fails
 * for any reason, we silently fall back to the rule-based briefing —
 * the skill must ALWAYS speak, even offline.
 *
 * Uses the Bedrock Converse API, so any Converse-compatible model works.
 */
const DEFAULT_MODEL = "amazon.nova-lite-v1:0";

const SYSTEM_PROMPT = [
  "You are the voice writer for a morning business briefing skill on Alexa.",
  "Rewrite the raw briefing below as a short spoken script.",
  "Rules: keep every fact and number EXACTLY as given — never invent or drop data;",
  "sound like a trusted morning assistant: warm, direct, no hype;",
  "no markdown, no emoji, no headings, no stage directions;",
  "keep it under 130 words and end with the top actions phrased as 'First... Then... Finally...' where possible.",
].join(" ");

export async function polishBriefing(briefing, { model, region } = {}) {
  const modelId = model || process.env.BEDROCK_MODEL;
  if (!modelId) return briefing; // Bedrock polish not enabled — use template voice

  let BedrockRuntime;
  try {
    ({ BedrockRuntime: BedrockRuntime } = await import("@aws-sdk/client-bedrock-runtime"));
  } catch {
    console.warn("[bedrock-insights] AWS SDK client-bedrock-runtime not installed; using template voice.");
    return briefing;
  }

  try {
    const client = new BedrockRuntime.BedrockRuntimeClient({ region: region || process.env.AWS_REGION || "us-east-1" });
    const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const resp = await client.send(new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        { role: "user", content: [{ text: `Raw briefing for today:\n\n${briefing}` }] },
      ],
      inferenceConfig: { maxTokens: 400, temperature: 0.4, topP: 0.9 },
    }));
    const polished = resp.output?.message?.content?.[0]?.text?.trim();
    return polished || briefing;
  } catch (err) {
    console.warn(`[bedrock-insights] Bedrock polish skipped (${err.name || "error"}); using template voice.`);
    return briefing;
  }
}

/** True when Bedrock polish is enabled — used by /health and the demo. */
export function bedrockEnabled() {
  return Boolean(process.env.BEDROCK_MODEL);
}
