/**
 * Demo simulator: prints what the Daily Ops Briefing agent says when a business
 * owner asks "Alexa, what's my business briefing?" - used for the demo video.
 */
import { buildBriefing } from "./server.js";
import { loadData } from "./data-layer.js";

const data = await loadData();

console.log("=== DAILY OPS BRIEFING - demo simulation ===\n");
console.log('USER:  "Alexa, what\'s my business briefing?"');
console.log("\nALEXA+:");
console.log(buildBriefing(data));

console.log('\nUSER:  "Alexa, I just sold another CV bundle."');
console.log("\nALEXA+: Logged 1 sale of the ATS-Ready CV + Cover Letter Bundle for USD 12 today. Nice work.");

console.log('\nUSER:  "Alexa, add a follow-up: pitch the Telegram bot to the new vendor tomorrow."');
console.log("\nALEXA+: Added \"Pitch the Telegram bot to the new vendor\" for tomorrow. I'll remind you when it's due.");

console.log('\nUSER:  "Alexa, mark the Matchaeologist follow-up as done."');
console.log("\nALEXA+: Marked \"Follow up with Matchaeologist if still quiet\" as done. Well done.\n");
