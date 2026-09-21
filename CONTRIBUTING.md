# Contributing

Thanks for kicking the tires on the Jev Dojo. It's a research/demo spike, so the bar is
"honest, typed, and fun to watch" rather than production hardening.

## Setup

```bash
nvm use            # Node 26 (.nvmrc)
npm install
npm run demo       # http://localhost:5178  (SIM mode with no key)
npm run typecheck  # must stay green
```

No `.env` needed to develop — everything runs in **SIM mode** offline. To exercise the LIVE
path, add a Jev key (see the README's *API tokens* table). Never commit `.env` — it's ignored.

## Ground rules

- **TypeScript 7, strict, ESM.** `npm run typecheck` must pass before you push. CI runs it.
- **Keep the scenes honest.** Show confidence; escalate or stop on low confidence; don't fake
  competence. The Gauntlet exists specifically to report Jev's real accuracy/latency/cost.
- **Server holds the keys.** The browser is a renderer — no secrets, no direct model calls.
- Match the surrounding style; keep comments about *why*, not *what*.

## Pull requests

1. Branch off `main`.
2. Keep the change focused; update the README if you change behavior or config.
3. Ensure `npm run typecheck` is green and describe how you verified any LIVE behavior.

## Reporting issues

Include what you ran (`npm run demo`, which scene), SIM vs LIVE, and what you expected vs saw.
Screenshots or a snippet of `logs/transactions.jsonl` help a lot.
