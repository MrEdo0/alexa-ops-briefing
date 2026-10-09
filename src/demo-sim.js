/**
 * Demo simulator: prints what the Daily Ops Briefing agent says when a business
 * owner asks "Alexa, what's my business briefing?" - used for the demo video.
 */
import { buildBriefing } from "./server.js";

console.log("=== DAILY OPS BRIEFING - demo simulation ===\n");
console.log('USER:  "Alexa, what\'s my business briefing?"');
console.log("\nALEXA+:");
console.log(buildBriefing());
console.log('\nUSER:  "Alexa, mark the Matchaeologist follow-up as done."');
console.log("\nALEXA+: Marked \"Follow up with Matchaeologist if still quiet\" as done. Well done.\n");
