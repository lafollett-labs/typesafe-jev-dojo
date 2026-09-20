# Jev / TypeSafe AI — Research Dossier & POC Plan

**Prepared by:** Marvin (Staff Engineer, LaFollett Labs) · **Date:** 2026-09-20
**Purpose:** Seed a POC repo under the lafollett-labs-workspace umbrella to prove Jev
out and build examples. Portable hand-off — everything needed to resume cold.
**Status:** Research complete (site + docs + 2 videos watched frame-by-frame + OpenRouter
page scraped). No code written yet. Live proof (curl) is drafted below, not yet run.

---

## TL;DR — the verdict

**Directionally right, worth a cheap POC, do NOT bet a project on the videos.**

A fast, cheap, *typed-decision* classifier sitting **beside** a premium LLM — the LLM
writes the rules and does the reasoning, Jev runs the fast repeatable decisions, humans
or deterministic code handle the exceptions — is a coherent, genuinely useful
architecture. That part is real.

**But:** every performance number in the two hype videos is promoter-supplied,
extrapolated, or best-case, and the *one* demo with a ground-truth scoreboard (a Bitcoin
buy/hold/sell bot) showed Jev **losing money at 10% confidence.** Trust the **category**,
not the **numbers**. Prove it ourselves.

**Recommendation:** build a small POC harness (a `poc/jev/` container that reuses our
keyproxy infra), **not** a Riff company — a company burns the Claude subscription window
on premium staff shifts to test a cheap classifier, which is upside-down. Save "spawn a
company" for the later question of how agents autonomously *use* proven Jev.

---

## What Jev actually is (verified facts)

Source: typesafe.ai, docs.typesafe.ai, and the OpenRouter model page (scraped).

- **A "System One" model** — makes fast, structured decisions for software, returning a
  **typed choice + calibrated probability**, not free-form text. "Suited for routing,
  classification, and other decision points where a fast, predictable answer matters more
  than generated prose."
- **Not an LLM / not autoregressive.** No token-by-token generation; one parallel pass.
  Founder's team admits "no internal reasoning shown."
- **Three primitives:**
  - `noul` (a.k.a. "nool") — yes/no → probability 0–1 (independent; does NOT sum to 100%)
  - `choice` — pick from named options → probability per option (sums to 100%)
  - `score` — rate against an ordered rubric you define
- **Intelligence:** self-described by the promoters as **"~Sonnet 5, not frontier level."**
- **Founder:** **Diogo Almeida** (note spelling — not "Diago"). Ex-OpenAI, real
  RLHF/ChatGPT contributor. Verified via TechCrunch. Company: TypeSafe AI, San Francisco.
- **Training:** synthetic data via "RLCD" (Reinforcement Learning from Calibrated
  Decisions) — their alternative to RLHF.
- **Marketing claim:** "20–200x faster, 40–400x cheaper (output free)." Independent
  reality is muddier (see Critical Read).

### Model / API facts (from the OpenRouter page + secondary sources)

| Fact | Value |
| - | - |
| Model / slug | Jev 1.13 · `typesafe/jev-1.13` (or `~typesafe/jev-latest`) |
| Released | 2026-09-18 |
| Context | 32,000 tokens |
| I/O | text in → structured decisions out |
| Price | **$0.042 / 1M input tokens · $0 output** |
| Endpoint | **`POST https://openrouter.ai/api/alpha/decisions`** (NOT `/v1/chat/completions` — that 400s) |
| Request body | `{ model, state, questions }` (questions = noul/choice/score) |
| Response | `{ model, answers, usage }` |
| Access | Waitlist/alpha. Instant via Vercel AI Gateway, or OpenRouter (we have credit). |

⚠️ Jev is **not** in OpenRouter's standard `/api/v1/models` list (446 models, zero Jev
hits) — it lives only under the alpha decisions product. Confirmed.

---

## How to prove it — step 1 (leanest, ~$0.0002, no window burn)

Direct curl to the decisions endpoint. Field names (`type`/`instructions`/`options`/
`levels`) are from secondary sources (the `prismhq/jev-router` and `itsmostafa/typesafe-mcp`
repos) — **confirm/repair on first run against OpenRouter's decisions docs; that is exactly
what this step proves.**

```bash
# Cali runs this (holds the key). $OPENROUTER_API_KEY must be set.
curl -s https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": "Customer email: My driveway needs power washing this weekend, can you help?",
    "questions": {
      "is_lead":  { "type": "noul",   "instructions": "Is this a genuine sales lead?" },
      "category": { "type": "choice", "options": ["sales","support","spam","other"] },
      "urgency":  { "type": "score",  "levels": ["low","medium","high"] }
    }
  }' | jq .
```

Expect a `{ model, answers, usage }` body with a probability for `is_lead`, per-option
probabilities for `category`, and a level for `urgency`.

### Step 2 — POC harness (the real deliverable)

A `poc/jev/` container, separate from the Riff app, that:
1. Wraps `{state, questions} → typed decisions` in a small typed client.
2. Runs **2–3 example decisions on real data** and **measures latency + accuracy
   ourselves** (the gap both videos have — they only ever show speed + cost, never
   correctness).
3. Rides **ShipIt's existing `openrouter` route** through the keyproxy — reusing the
   Tier-2 infra we just shipped and validating it end-to-end **without running ShipIt's
   staff** (no window burn).

**Infra nuance:** the keyproxy resolves the company from a scoped token and injects *that
company's* key, so "use the proxy" is coupled to a company context. Two paths:
- **Direct-to-OpenRouter** (bypasses proxy) — simplest for the first proof.
- **Through the proxy** — hit `/svc/openrouter/api/alpha/decisions` with a scoped token in
  ShipIt's context. **Verify first** that our `openrouter` service route's upstream base
  does NOT pin `/api/v1` (if it does, the alpha path won't forward). Check
  `src/keyproxy/main.ts` route synthesis + the ShipIt `openrouter` service definition.

Candidate example decisions to build (each maps to a real LaFollett Labs use case):
- **Model-router / shift-triage classifier** — "does this task need Opus/Fable or Haiku?"
  (maps to Riff's real constraint: the subscription window).
- **Tool-call pre-screener** — flag risky agent tool calls for a human/deterministic gate
  (the ONLY safe shape near a security boundary — see Fit Analysis).
- **Lead/support triage** — for Corebizy.ai's inbound queue.

---

## Fit analysis — where this belongs in LaFollett Labs

| Target | Verdict | Notes |
| - | - | - |
| **Riff shift-model triage** | ✅ Highest value | Jev classifies "Opus/Fable vs Haiku?" → routes cheap vs heavy. Direct leverage on the subscription window. **Advisory + measured, never autonomous** — a wrong route wastes a whole shift. |
| **Riff gate / permissions** | 🚫 Hard NO | A probabilistic classifier is never a security control. "A control you can argue with is not a control" (CLAUDE.md). Jev may *pre-screen* risky tool calls → the **deterministic gate still decides**. Advise, never decide. The Bitcoin failure is Exhibit A. |
| **ShipIt product** | 🟡 Their call | Factory is full of "expensive queue" decision points; typed+calibrated output flatters their **auditable** north-star. But "their code is not ours to change" — surface as a board **option with caveats**, not a directive. |
| **Corebizy.ai** | 🟡 Plausible | Lead scoring / support routing / moderation fit the "front of the queue" thesis. Need to know what Corebizy *does* before committing. |

**The pairing pattern (both videos converge on it):**
`LLM (Astra/Claude) writes THE RULES → Jev CLASSIFIES & ROUTES → agent/human REVIEWS
EXCEPTIONS → back to the LLM.` The flight-booking demo credited "Operation + index by
Jev, Text by mercury-2.5" — Jev decides fast, an LLM generates. This is the shape to build.

---

## Critical read — why not to trust the numbers

All three videos are **promos, not benchmarks:**

- **Conflicts of interest:** Ryan Vogel is an OpenCode founder; Greg Isenberg pushes
  ideabrowser/Vercel; Jack Roberts runs affiliate links (Glaido code WHSAAKXO) and
  self-built localhost apps on both sides of every test.
- **"~200ms" doesn't survive its own telemetry:** the real completed email run showed
  **avg 431ms, p95 1,144ms, max 7,949ms, 768 HTTP-429 rate-limit retries.** 200ms holds
  only for tiny inputs.
- **Almost zero *independent* accuracy evidence.** Every demo measures speed + cost,
  never correctness; the only ground-truth test (Bitcoin P&L) showed Jev **losing
  money**. TypeSafe's *own* marketing (video 3) is the lone exception, and it is
  telling: their Pareto chart puts Jev at **~68% accuracy** — cheapest at that tier,
  but **below Sol (~73%), Opus 5 (~72%) and Terra (~70%)**. Even by their own numbers,
  Jev is not the most accurate; it is the cheapest at ~68%. `Watch: 2z-7pIj57f8 01:57`
- **"Zero hallucinations" is far narrower than it sounds.** That slide measures
  **Structured Output Error Rate** (malformed/invalid output): Jev 0.00% vs Sonnet 5
  **12.6%**, Fable 5.1 7.99%, Opus 5 3.76%, Gemini 3.8 Flash 2.38%. That is
  schema-validity, **not** correctness — the same slide's accuracy chart still has Jev
  wrong ~1-in-3. Do not read "0% hallucination" as "reliable decisions." `Watch: 2z-7pIj57f8 04:52`
- **Costs check out, though:** the "1,700 emails for $0.18" figure is real on screen
  (4.2M in / 500K out). Cost is the genuine strength; per-token price is low — total cost
  depends on **call volume**, not the headline.
- **Fabricated/near-future demo data:** the "1,700 real emails" set is seeded with
  synthetic rows. Roberts' dollar figures are all self-labeled "extrapolation, not a batch
  test" (`projected = actual × 20 × 1,000`).
- **Founder's team's honest line is the useful one:** "heavy **advisory role**,"
  ~Sonnet-5 intelligence, "not frontier level," "I would NOT put this in front of your
  stock portfolio."

**Note:** the video-1 sub-agent flagged Fable 5.1 / Opus 5 / GPT-6 Astra as "models it
can't confirm exist" and hinted the whole thing might be staged — that was its stale
training cutoff. Those models are real, the date is real, and Jev/TypeSafe is real
(TechCrunch, LangChain, Cloudflare, the OpenRouter page). Methodology skepticism kept;
"it's fake" overreach discarded.

---

## Open questions to resolve in the POC

1. Exact `questions` schema field names on the OpenRouter decisions endpoint (step 1
   confirms).
2. Does our `openrouter` keyproxy route pin `/api/v1`? (blocks the through-proxy path if so)
3. Real **accuracy** on our own labeled data — now with a self-reported target to
   beat/confirm: TypeSafe claims **~68%** on their 4-workflow average (`Watch: 2z-7pIj57f8 01:57`).
4. Real **latency** distribution on our payload sizes (not their cherry-picked demos).
5. Rate limits on the alpha endpoint (the 768 HTTP-429s are a warning).

---

## Sources

- TechCrunch — https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/
- LangChain "building a harness with Jev" — https://www.langchain.com/blog/building-a-harness-with-jev
- TypeSafe docs — https://docs.typesafe.ai/introduction · https://docs.typesafe.ai/concepts/system-one
- OpenRouter model page — https://openrouter.ai/typesafe/jev-1.13 · provider https://openrouter.ai/typesafe
- OpenRouter Jev lab (7 examples) — https://openrouter.ai/labs/jev
- jev-router (LiteLLM) — https://github.com/prismhq/jev-router
- typesafe-mcp PR (OpenRouter transport) — https://github.com/itsmostafa/typesafe-mcp/pull/6
- Video 1 — "Jev AI Just Dropped, And…" (Jack Roberts) — https://youtu.be/9C8opPBjAIk
- Video 2 — "Jev is HERE. How to use it" (Greg Isenberg × Ryan Vogel) — https://youtu.be/4mTLpuQpB80
- Video 3 — "We need to talk about Jev…" (Matthew Berman) — https://youtu.be/2z-7pIj57f8

Local watchwith bundles (frames + transcript, re-readable): `~/.watchwith/bundles/9C8opPBjAIk/`, `~/.watchwith/bundles/4mTLpuQpB80/`, and `~/.watchwith/bundles/2z-7pIj57f8/`.

---

# Appendix A — Video 1 scribe (Jack Roberts, "Jev AI Just Dropped, And…", 11:53)

24 data-carrying frames read. Timestamps are `Watch: 9C8opPBjAIk MM:SS`.

**Primitives / "not an LLM":**
- 00:39 "WHY JEV MATTERS" slide (verbatim): FAST DECISIONS "70–500 ms reported"; LOW INPUT
  COST "$0.042 / 1M tokens"; FREE OUTPUT "0"; TYPED ANSWERS; MEASURE UNCERTAINTY;
  PARALLEL QUESTIONS. (Note the hedge "reported.")
- 01:16 "Three ways to decide": NOUL "Yes or no"; CHOICE "Pick an option"; SCORE "Choose a
  level." Skill page (06:25): "Noul returns the probability of yes… Choice selects from
  your named options… Score places the record on your written scale."
- 05:44 "not an LLM": "Jev doesn't give you language… hence it can do things in a
  completely different way." 11:16: "This is not a chat model. It's optimized for making
  incredibly fast micro-decisions."
- 10:50 intelligence: "about as smart as a Sonnet 5… not Frontier level." Use only for
  yes/no, pick an option, or a score.

**Five benchmark levels (all in his own localhost apps — "JEV LIVE LAB"):**
- L1 Inbox (20 emails/side): Test 1 spam/scam (NOUL): Jev 3.41s, 20/20, 0 err (~$0.019/1k)
  vs Astra 9.93s, 20/20, "$4.68 est/1k." Screen "2.91× sooner." Test 2 routing (CHOICE):
  Jev 2.56s vs Astra 11.79s "$7.41 est/1k." Test 3 buyer signal (NOUL): Jev 2.57s vs Astra
  10.31s "$4.66 est/1k."
- L2 Community: churn (SCORE 0–3): Jev 2.82s, $0.022/1k, median 442ms vs Astra 9.24s,
  $3.70/1k, median 1675ms. "Projected cost = actual cost × 20 × 1,000."
- L3 AI slop: card "1,000 ACTIVITIES: JEV $0.042 | ASTRA $15.00." Live: Jev 90% / Astra
  100% (both "reads as slop"). Footer: "Extrapolation, not a batch test," "Speed is not
  accuracy."
- L4 Design system pick (300+ pages): Jev "$1.94–1.95 est/1,000 briefs," Astra ≈ "$500/1k"
  (verbal, no Astra panel). Brief 2: both "found the exact same thing" (agreement).
- L5 Model routing (20-model lineup): Jev 0.494s, 5/5 routed vs Astra 0.623s, 0/5 (still
  routing). Routes: security refactor→GPT-5.6 Sol, video pack→MiniMax M3, image edit→Nano
  Banana 2, disputed science→GPT-6 Astra, production UI→Claude Fable 5.1.

**API / OpenRouter:** the slug + page are NEVER shown on screen — only in the description.
On screen he uses a Notion "free skill" ("Give your AI agents Jev reflexes") with a
natural-language prompt; outputs `results.jsonl` + `summary.json`; default 4 workers, 60s
timeout. SlopMonster repo is MIT, AI-authored. No API schema/code ever shown.

**Wrong/limits:** no frame shows Jev clearly wrong; every email test 20/20 for both models;
design picks identical. Only disagreement: churn msg 3 Jev 1.9 vs Astra 2.0. Despite an
"uncertain cases" feature, none shown. Disclaimer on screen: "Speed is not accuracy."

**Pairing:** 01:37 "Astra × Jev" diagram: Astra PLAN & BUILD → THE RULES → Jev CLASSIFY &
ROUTE → REVIEW EXCEPTIONS → back to Astra. Skill: "Astra or Claude writes the decision
rules, Jev works through the records, and your agent reviews the exceptions."

**Critical:** enthusiast/affiliate promo; controls both sides; all $ figures are
estimates/extrapolations; results implausibly clean; monetization throughout (Glaido code,
paid masterclass, lead-magnet tools). Direction coherent; specific numbers not
independently verifiable.

---

# Appendix B — Video 2 scribe (Greg Isenberg × Ryan Vogel, "Jev is HERE", 28:24)

18 frames read. Timestamps are `Watch: 4mTLpuQpB80 MM:SS`.

**Mental model:**
- 03:17 "JEV IS A CLASSIFIER — Give it choices. It gives back a probability for each one."
  INPUT (any object) → SCHEMA (choices) → OUTPUT (per-choice %, "Always adds up to 100%"
  for enum choices). "Send an input and a schema, like any API call. Jev returns only the
  numbers, in about 200ms."
- 03:16 Vogel: "I won't get into the architecture… because honestly I don't even
  understand it that well."
- 12:06 "DECISION MODEL ≠ CHAT MODEL" slide: chat = words in / streamed text / ~30s;
  decision = input+schema / numbers+categories / no reasoning shown / ~200ms / type-safe.
- 12:22 "There's no internal reasoning… Or it might do that on the server. We don't really
  know."
- 22:51 Excalidraw whiteboard: email → jev → `is_good_lead: nool 0-1`, `category:
  marketing/finance/spam`; `is_spam: 0.20`. (nool = probabilistic boolean, independent —
  does NOT sum to 100%, unlike enum choices.)

**Email triage (04:32):** dashboard, 64 workers, 1,701 emails; schema = category / priority
/ spam% / reply%. Completed run (06:46–07:08): 1,701/1,701, 0 failed, **Est. cost $0.181**,
tokens **4,299,386 in / 495,533 out**, **avg latency 431ms, p95 1,144ms, range
335–7,949ms, 768 API retries (last HTTP 429)**. Per-email times up to ~3,893ms. **No
accuracy/ground-truth shown.**

**LIMITS (22:51 — the critical segment):**
- 22:54 Vogel verbatim: "I wanted to hook Jev up to a Bitcoin signal… buy, hold, or sell.
  And it does not seem to be doing well, which shows this model is great, but it does have
  some regressions. **I would not put this model in front of like your stock portfolio or
  Bitcoin.** This is just for routing or other decisions… where it doesn't need insane
  model intelligence."
- 22:56 Bitcoin dashboard (jev-1.13.0): verdict "Sell" at **10% choice confidence, -0.52
  combined score**; $1,000 paper → **value $996.29, return −0.37%**, fees $7.99. Decision
  mix buy 24 / hold 40 / sell 36 (near coin-flip). "41% model probability that an
  actionable edge exists" (i.e. more likely NO edge).
- 23:11 "I did a test with GPT6 Astra… it did a little better because it cross-referenced
  news… it's a different type of model." → reserve frontier LLMs for high-intelligence
  tasks (trading); Jev for fast routing only.
- 18:33 "should be a very heavy advisory role."

**Other use cases:** lead scoring (`is_good_lead` 0–1; 98% → fast human reply); support
routing (200ms triage); "AI traffic cop" (Jev decides importance → human / automation / LLM
/ ignore); "front of the expensive queue" startup thesis (local-services matching, instant
quotes); auto-clipping video (24:03 — transcribe → Jev scores moments, "17 moments in ~3s"
spoken vs "11 clips in ~2s" on screen); browser control (25:27 — Zürich→London flight in
"7.1s," 8 actions, 146ms median decision latency; "Operation+index by Jev, Text by
mercury-2.5").

**Access:** waitlist; instant via **Vercel AI Gateway**; typesafe.ai. No OpenRouter
mention in this video. Founder post on screen (24:40): "co-inventing ChatGPT… 2 years in
stealth building RLCD… Jev — 20–200x faster · 40–400x cheaper (output free) · Frontier
composable intelligence optimized for decisions."

**Critical:** heavy COI (Vogel = OpenCode founder; Isenberg = ideabrowser/Vercel; access
funneled through Vercel). Demo data fabricated/near-future-seeded (not a real inbox).
"200ms" contradicted by own telemetry (431ms avg). Polished "proof" cards are editor's
marketing overlays, not Jev output. No accuracy evidence; the one ground-truth test
(Bitcoin) shows Jev losing money. Internal number inconsistencies (clipper, flight timer).

---

# Appendix C — Video 3 scribe (Matthew Berman, "We need to talk about Jev…", 12:31)

12 payload frames read (full transcript mapped). Timestamps are `Watch: 2z-7pIj57f8 MM:SS`.
Mostly a hype/overview promo; the value is three on-screen data frames.

**⭐ Accuracy — the first numbers anyone has shown (TypeSafe's own slides):**
- 01:57 & 04:52 "Average of 4 workflows: accuracy vs cost" / "Pareto Curve": **Jev ≈ 68%**
  accuracy at ~$0.0001 (cheapest point, on the frontier). Above it on accuracy: **Sol ≈ 73%,
  Opus 5 ≈ 72%, Terra ≈ 70%**; near it: Luna ≈ 66%, Sonnet 5 ≈ 66%; below: Haiku 4.5 ≈ 52%.
  Frontier line label: "nothing is both cheaper and more accurate." → Jev is the **cheapest
  at ~68%**, not the most accurate. **This is the target our own harness must confirm.**
- 04:52 "Hallucinations — Structured Output Error Rate": **Jev-1.0 0.00%**, GPT-5.6 Luna
  0.49%, Terra 0.58%, Sol 1.93%, **Claude Sonnet 5 12.6%**, Opus 5 3.76%, **Fable 5.1 7.99%**,
  Gemini 3.8 Flash 2.38%, Gemini 3.1 Pro 1.92%. Caption: "Every Jev decision comes with a
  confidence estimate." **Critical:** this is malformed-output rate, NOT correctness.

**🧨 On-screen request schema (verbatim `JavaScript` slide, 03:38-03:53) — OLD naming:**
```javascript
// 1. Support ticket routing
{
  state: { message: "I was charged twice and need this fixed today.", customerPlan: "Pro", accountAgeDays: 420 },
  questions: {
    category: { type: "choice",  options: ["billing","technical","cancellation","other"], instructions: "What type of support request is this?" },
    urgent:   { type: "boolean", instructions: "Does this need urgent handling?" },
    priority: { type: "score",   instructions: "Rate support priority.", levels: ["low","medium","high","critical"] }
  }
}
```
Uses `options`/`levels`/`boolean` and a **structured-object** `state` — contradicts the
current docs (`criteria`/`noul`). Likely pre-launch naming (video is Sep 15-17; OpenRouter
launch Sep 18). Reconciled in `jev-api-contract.md`; live 422 is the tie-breaker.

**Speed/cost demos (real scoreboards):**
- 02:47-03:05 WikiRace ("Rubber duck → Lamport's bakery algorithm"): **Jev 1.13.0 0.544s /
  5 hops / 0.036¢** vs GPT-5.6 Luna 4.694s/0.084¢, Claude Sonnet 5 4.900s/1.763¢ (49.3× cost),
  GPT-5.6 Sol 5.030s/1.650¢. "8.63× faster." Footer: "Model time excludes Wikipedia loading."
- 10:07-10:18 Chess (5+0 blitz, "every move is one API call"): **Jev wins only by flagging.**
  vs Fable 5.1 — Fable +16 material by move 29, promoted 2nd queen, but burned 6-15s/move;
  Jev answered ~2.6s → Fable lost on time ("JEV V13 WINS — BLACK LOST ON TIME"). vs GPT-6
  Astra — Astra mated Jev in 18 moves (Qe1#) with 2:27 to spare. Confirms: fast, not smart.

**Positioning / claims:**
- 01:05-01:28 Founder tweet (Diogo Almeida @CompleteSkeptic, Sep 15, 29.1M views): "20-200x
  faster · 40-400x cheaper (w/ output tokens free) · Frontier composable intelligence
  optimized for decisions · AFAICT the shortest path to AI-based economic revolution."
- 04:10 TypeSafe landing slide: **"We're Building Prod, Not God."** (jab at Anthropic).
  Footnote frames Jev as neuro-symbolic — "cheekily summarized as 'smart if-statements.'"
- Berman's own framing: free output tokens, input fractions of a penny; "not a chat model…
  not for coding from the ground up"; use for high-volume parallel decisions; 0% (structured)
  hallucination pitched for healthcare/military/traffic — **exactly the autonomous-critical
  uses our Fit Analysis says Jev must NEVER decide alone.**

**Critical:** solo-creator promo (Zapier sponsor segment 05:08-06:22 skipped). All charts are
TypeSafe's own marketing, not independent. "Real-time" demos (Doom, AI town, Skittles, FSD,
Melee) show speed, never correctness. Useful takeaways: the ~68% accuracy target and the
"zero hallucination = 0% malformed output ≠ correct" distinction. Category confirmed, numbers
still to be proven by us.
