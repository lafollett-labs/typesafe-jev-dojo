# typesafe-jev-dojo 🥋

A spike repo for kicking the tires on **Jev** — TypeSafe AI's "System One" decision
model (fast typed decisions, *not* an LLM). Goal: measure what the hype videos never
did — **accuracy and real latency on our own data** — and show it off with a live,
graphical demo.

## The live demo

```bash
nvm use            # Node 26 (see .nvmrc)
npm install
npm run demo       # http://localhost:5178
```

Runs a Node server + canvas UI with three real-time scenes over a WebSocket:

| Scene | What it shows |
| - | - |
| **Router** | Tasks stream in; Jev answers 3 questions each (which model · needs-human? · risk) and routes down neon lanes. Low confidence / high risk escalates to **REVIEW** instead of guessing. Live throughput, latency, $-saved-vs-Opus, and a **decision feed** showing each task + its route. **Starts PAUSED** — press **Start** to route, **Pause** to stop; nothing is called until you do. |
| **Reflex** | A closed control loop — Jev **pilots a craft** through scrolling gates, one decision per tick (choice: left/stay/right) against the state it sees. The environment generates its own endless real-time data; distance + crash counter is the honest scoreboard. **Starts PAUSED.** |
| **Swarm** | Broadcast one event; Jev fires N decisions **in parallel**; hundreds of agents react, colored by choice, haloed by confidence. |
| **Gauntlet** | Same labeled tasks → **Jev vs Claude**, scored against ground truth. Green/red per task + honest accuracy / latency / cost bars. |

### Controls & stopping

- The **Router opens paused**; **Start / Pause** and a speed slider gate every live call.
- **Swarm** and **Gauntlet** only run on their button press — never on their own.
- To kill the whole server: **Ctrl+C** in its terminal (or `pkill -f "src/server/index.ts"`).

### SIM vs LIVE

With **no key**, the demo boots in **SIM mode** (badged amber) — decisions are generated
locally so the graphics run. Add a key to `.env` and it flips to **LIVE** (green badge),
making real Jev calls. Transport preference: **native TypeSafe → OpenRouter → SIM**.

```bash
cp .env.example .env
# then set ONE Jev transport:
#   TYPESAFE_API_KEY=...     # native (you have access) — authoritative schema. PREFERRED.
#   OPENROUTER_API_KEY=...   # alternate transport
# and (optional) the Gauntlet's Claude opponent, billed to your SUBSCRIPTION:
#   claude setup-token   ->  paste as CLAUDE_CODE_OAUTH_TOKEN=...
#   npm i @anthropic-ai/claude-agent-sdk
```

## Other entrypoints

```bash
npm run smoke      # fire ONE real decision, print raw + typed + latency + cost (settles the schema)
npm run typecheck  # TS 7, strict
```

## Layout

```
src/jev/          Typed Jev client — answers inferred from your questions; native + OpenRouter transports
src/shared/       WebSocket protocol shared by server and client
src/server/       Demo server: live Jev + Claude-subscription, SIM fallback, scene engines
src/client/       Canvas UI (index.html + main.ts, bundled on the fly by esbuild)
src/smoke.ts      One-shot schema/latency proof
docs/
  jev-api-contract.md        Verified, buildable API contract (the truth we code to)
  jev-research-dossier.md    Research narrative (schema section superseded by the contract)
```

## Still to confirm on first LIVE call

The response key shape (`choice`/`score`/`noul` vs a flattened `answer`) is confirmed
against native docs but not yet a live call. `npm run smoke` dumps the **raw** response
first — if keys differ, adjust `AnswerFor` in `src/jev/types.ts`. See `docs/jev-api-contract.md`.
