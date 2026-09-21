/**
 * Batch benchmark — Jev answers a whole panel of typed questions about ONE state
 * in a SINGLE request, in parallel. This fires the same 10-question panel two ways:
 * batched (1 call) and sequential (1 call per question), and compares latency, tokens,
 * and cost. Batching sends the ticket once; sequential re-sends it every call.
 *
 * Run:  npm run batch      (requires TYPESAFE_API_KEY or OPENROUTER_API_KEY in .env)
 */
import { JevClient, JEV_TRANSPORTS, choice, estimateCostUSD, noul, score } from "./jev/index";
import type { Questions } from "./jev/index";

const ticket =
  "I've been charged twice for my Pro plan this month and the second charge put my account " +
  "over its credit limit. This is the third billing mistake this year — I'm honestly considering " +
  "cancelling. Can someone fix this TODAY? I'd also like to know if the Team plan gives volume " +
  "pricing for 12 seats.";

const panel = {
  intent: choice("Primary intent of this support ticket", { billing: "Payments, invoices, refunds, charges", technical: "Bugs, errors, product problems", sales: "Pricing, plans, upgrades, pre-sale questions", spam: "Junk / phishing / not a real customer", account: "Login, password, access, account management" }),
  priority: score("How urgently should a human act on this", ["whenever", "this week", "today", "right now"]),
  sentiment: score("The customer's emotional tone", ["happy", "neutral", "annoyed", "furious"]),
  churn_risk: score("Risk this customer churns or leaves", ["none", "low", "elevated", "high"]),
  is_urgent: noul("The customer expects action today"),
  needs_refund: noul("A refund or billing correction is warranted"),
  is_spam: noul("This is spam or phishing, not a genuine customer"),
  needs_human: noul("This needs a human agent, not an automated reply"),
  upsell: noul("There is a genuine upsell or expansion opportunity"),
  is_english: noul("The message is written in English"),
};

function line(answers: Record<string, { type: string; choice?: string; score?: number; noul?: number; confidence?: number }>): string {
  return Object.entries(answers)
    .map(([k, v]) =>
      v.type === "choice" ? `${k}=${v.choice}(${Math.round((v.confidence ?? 0) * 100)}%)`
        : v.type === "score" ? `${k}=${(v.score ?? 0).toFixed(2)}`
          : `${k}=${(v.noul ?? 0).toFixed(2)}`)
    .join("  ");
}

async function main(): Promise<void> {
  const ts = process.env.TYPESAFE_API_KEY?.trim();
  const or = process.env.OPENROUTER_API_KEY?.trim();
  const t = ts ? JEV_TRANSPORTS.native : JEV_TRANSPORTS.openrouter;
  console.log(`transport: ${ts ? "native TypeSafe" : "OpenRouter"} · ${t.baseUrl}${t.path} · ${t.model}\n`);
  const jev = new JevClient({ apiKey: ts || or, baseUrl: t.baseUrl, path: t.path, model: t.model });

  // 1) BATCHED — all 10 questions in one request, answered in parallel.
  const b0 = performance.now();
  const batched = await jev.systemOne({ state: ticket, questions: panel });
  const bMs = performance.now() - b0;
  console.log("=== BATCHED (1 request · 10 questions) ===");
  console.log(line(batched.answers as never));
  console.log(`latency ${bMs.toFixed(0)}ms · input_tokens ${batched.usage.input_tokens} · $${estimateCostUSD(batched.usage).toFixed(6)}\n`);

  // 2) SEQUENTIAL — the same 10 as separate calls (the ticket is re-sent each time).
  let seqTok = 0, seqCost = 0;
  const s0 = performance.now();
  for (const [key, q] of Object.entries(panel)) {
    const r = await jev.systemOne({ state: ticket, questions: { [key]: q } as unknown as Questions });
    seqTok += r.usage.input_tokens;
    seqCost += estimateCostUSD(r.usage);
  }
  const seqMs = performance.now() - s0;
  console.log("=== SEQUENTIAL (10 requests · 1 question each) ===");
  console.log(`latency ${seqMs.toFixed(0)}ms · input_tokens ${seqTok} · $${seqCost.toFixed(6)}\n`);

  const bTok = batched.usage.input_tokens || 1;
  console.log("=== VERDICT ===");
  console.log(`speed:  ${(seqMs / bMs).toFixed(1)}x faster batched  (${bMs.toFixed(0)}ms vs ${seqMs.toFixed(0)}ms)`);
  console.log(`tokens: ${(seqTok / bTok).toFixed(1)}x fewer batched   (${bTok} vs ${seqTok} — the ticket is re-sent every sequential call)`);
  console.log(`cost:   $${estimateCostUSD(batched.usage).toFixed(6)} batched  vs  $${seqCost.toFixed(6)} sequential`);
}

main().catch((err: unknown) => {
  console.error("\n💥 Batch benchmark failed:", err);
  process.exitCode = 1;
});
