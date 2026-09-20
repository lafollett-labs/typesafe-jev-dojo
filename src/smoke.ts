/**
 * Smoke test — fire the canonical support-ticket triage at Jev via OpenRouter,
 * confirm the wire format, and MEASURE latency + cost ourselves (the gap every
 * hype video dodged).
 *
 * Run:  npm run smoke      (requires OPENROUTER_API_KEY in .env)
 */
import { JevClient, JEV_TRANSPORTS, choice, estimateCostUSD, noul, score } from "./jev/index";

const ticket =
  "Hi, I've been trying to connect my Stripe account for 3 days and the " +
  "integration keeps failing. I'm losing sales. Please help ASAP.";

async function main(): Promise<void> {
  // Prefer native TypeSafe (authoritative schema) → OpenRouter.
  const ts = process.env.TYPESAFE_API_KEY?.trim();
  const or = process.env.OPENROUTER_API_KEY?.trim();
  const t = ts ? JEV_TRANSPORTS.native : JEV_TRANSPORTS.openrouter;
  console.log(`transport: ${ts ? "native TypeSafe" : "OpenRouter"} · ${t.baseUrl}${t.path} · ${t.model}`);
  const jev = new JevClient({ apiKey: ts || or, baseUrl: t.baseUrl, path: t.path, model: t.model });

  const questions = {
    department: choice("Which team should handle this", {
      billing: "Payment or subscription issues",
      technical: "Bugs or integration problems",
      sales: "Pricing or account questions",
    }),
    frustration: score("How frustrated the customer appears", [
      "Calm, just stating facts",
      "Frustrated but civil",
      "Very angry, strong language",
    ]),
    is_urgent: noul("The message conveys urgency or time-sensitivity"),
  };

  const t0 = performance.now();
  const res = await jev.systemOne({ state: ticket, questions });
  const ms = performance.now() - t0;

  console.log("\n=== RAW RESPONSE ===");
  console.log(JSON.stringify(res, null, 2));

  // Every read below is statically typed from the `questions` map above.
  console.log("\n=== TYPED READ ===");
  console.log("department:", res.answers.department.choice, res.answers.department.probabilities);
  console.log("frustration:", res.answers.frustration.score, "->", res.answers.frustration.legend);
  console.log("is_urgent  P(yes):", res.answers.is_urgent.noul);

  console.log("\n=== MEASURED (what the videos never showed) ===");
  console.log(`latency:      ${ms.toFixed(0)} ms`);
  console.log(`input tokens: ${res.usage?.input_tokens ?? "?"}`);
  console.log(`est. cost:    $${estimateCostUSD(res.usage).toFixed(6)}`);
  console.log(`model:        ${res.model}`);
}

main().catch((err: unknown) => {
  console.error("\n💥 Smoke failed:", err);
  process.exitCode = 1;
});
