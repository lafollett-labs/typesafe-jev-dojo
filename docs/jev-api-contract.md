# Jev API Contract — Verified (OpenRouter transport)

**Date:** 2026-09-20 · **Status:** Verified from primary docs; one response-shape
detail pending first live call. **Supersedes** the guessed schema in
`jev-research-dossier.md` (which invented `options` / `levels` — both wrong).

> **Transport decision (updated 2026-09-20):** We now have **native TypeSafe access**
> (`api.typesafe.ai/v1/systemone`) — the authoritative `criteria`/`noul` schema, which
> our client already matches. **Native is now preferred; OpenRouter is the fallback.**
> Both are documented below; the demo/client auto-select native when `TYPESAFE_API_KEY`
> is set (see `JEV_TRANSPORTS`).

---

## Endpoint

**Native (preferred):**
```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```
- Model slug: `jev-latest` (or `jev-1.13`).
- Authoritative `criteria`/`noul` schema — our client + types match it exactly.

**OpenRouter (fallback):**
```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```
- Still on the `/api/alpha/` path — **may move**. Pin nothing.
- **Chat-completions SDKs do NOT work here.** It is a distinct product.
- Model slug: `typesafe/jev-1.13` (or `typesafe/jev-latest`).

Both: **$0.042 / 1M input tokens, output free** (~$0.000018 / typical call). Same
`{model, state, questions}` body.

---

## Request body

```json
{
  "model": "typesafe/jev-1.13",
  "state": "<text | object | array to evaluate>",
  "questions": {
    "<your_question_id>": { "type": "noul | choice | score", "...": "..." }
  }
}
```

`questions` is a **map**: your key → a typed question. Each is evaluated in
parallel, in isolation, against the same `state`.

### Question types (canonical: `instructions` + `criteria`)

| Type | Shape | Returns |
| - | - | - |
| `noul` | `{ type, instructions, criteria?: { true, false } }` | `noul`: P(yes) 0..1 (independent) |
| `choice` | `{ type, instructions, criteria: { key: "desc" } }` (≤255) | `choice` key + `probabilities` (sum ~1) + `confidence` |
| `score` | `{ type, instructions, criteria: [ "lvl0", "lvl1", ... ] }` (2–10) | `score` **float** (interpolated) + `probabilities` + `legend` + `confidence` |

```json
{
  "department":  { "type": "choice", "instructions": "Which team should handle this",
                   "criteria": { "billing": "Payment issues", "technical": "Bugs", "sales": "Pricing" } },
  "frustration": { "type": "score",  "instructions": "How frustrated the customer appears",
                   "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry"] },
  "is_urgent":   { "type": "noul",   "instructions": "The message conveys urgency" }
}
```

> **OpenRouter gotcha:** it validates `instructions` and `criteria` values as
> **strings** (the documented TypeSafe wire format). Plain-string values (what we
> use) pass through. Any *structured* value must be **JSON-encoded to a string** first.

---

## Response body

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department":  { "type": "choice", "choice": "technical",
                     "confidence": 0.78, "probabilities": { "technical": 0.85, "billing": 0.15, "sales": 0.0 } },
    "frustration": { "type": "score", "score": 1.0, "confidence": 1.0,
                     "legend": { "0": "Calm...", "1": "Frustrated...", "2": "Very angry" },
                     "probabilities": { "0": 0.0, "1": 1.0, "2": 0.0 } },
    "is_urgent":   { "type": "noul", "noul": 1.0 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

- `score` is a **weighted expected value** across levels (e.g. `1.05`), not an argmax.
- `noul` is a bare probability; `choice`/`score` add `probabilities` + `confidence`.

### ⚠️ Confirm on first live call — the field names are genuinely contested

**Three** schema variants exist in the wild. Only a live call against OpenRouter's
`/api/alpha/decisions` **today** settles which it accepts:

| Source | choice options | score levels | yes/no type |
| - | - | - | - |
| **Current docs.typesafe.ai + OpenRouter Go SDK** (what our client sends) | `criteria: { key: "desc" }` | `criteria: [ ... ]` | `noul` |
| Berman demo slide (Sep 15) + dossier's secondary repos | `options: [ ... ]` | `levels: [ ... ]` | `boolean` |

Most likely the schema was **renamed pre-launch** (`options`/`levels`/`boolean`
→ `criteria`/`noul`), so the current docs win. But if the first call **422s on
validation**, flip the builders in `src/jev/index.ts` to emit `options`/`levels`/
`boolean` and adjust `src/jev/types.ts`. (Source: Berman video, verbatim on-screen
`JavaScript` slide — `Watch: 2z-7pIj57f8 03:38-03:53`.)

**`state` may be a structured object**, not just a string — the same slide sent
`state: { message, customerPlan, accountAgeDays }`. Our `SystemOneRequest.state`
already allows `string | object | array`. ✅

**Response keys:** docs show per-type keys (`choice`/`score`/`noul` + `probabilities`
+ `confidence`); one community README showed a flattened `{ answer, probabilities,
confidence }`. **The smoke test's RAW dump is the arbiter** — if keys differ, adjust
`AnswerFor` in `src/jev/types.ts`. Also confirm `usage.input_tokens` isn't renamed
to `prompt_tokens`.

---

## Errors & limits

| Status | Meaning | Client behavior |
| - | - | - |
| 401 | Bad key | throw |
| 422 | Validation failed (wrong field names!) | throw — read the body |
| 429 | Rate limited | retry w/ backoff (honor `Retry-After`) |
| 5xx / 529 | Overloaded | retry w/ backoff |

The video-2 telemetry showed **768 HTTP-429s** in one batch — rate limits are real.
Client default: 3 retries, exponential backoff, `Retry-After` honored.

---

## Sources

- Native contract — https://docs.typesafe.ai/api.md · https://docs.typesafe.ai/introduction/quickstart.md
- Primitives — https://docs.typesafe.ai/primitives/{noul,choice,score,advanced}.md
- JS SDK class — https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md
- OpenRouter Decisions (Go SDK README) — https://openrouter.ai/docs/client-sdks/go/sdks/decisions/README
- Reference impls — github.com/vinaychawla-ops/jev-openrouter-example · github.com/itsmostafa/typesafe-mcp (PR #6)
