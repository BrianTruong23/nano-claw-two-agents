# Dreaming (Light / REM / Deep)

**Dreaming** is a scheduled **memory consolidation** pass that runs **inside the container** before the model turn. It improves **user-need signals** (promoted to `MEMORY.md`) and supports **self-improvement** (patterns in archives and tags; optional tie-in to `reflect.md` in chat).

It complements **[nightly reflect](nightly-reflect.md)** (`[nano-claw:overnight-reflect]`), which focuses on **tool-use** bullets in `reflect.md`. Dreaming focuses on **durable user/context facts** in `MEMORY.md`.

## Trigger

Schedule a task whose `prompt` **starts** (after trim) with:

```text
[nano-claw:dreaming]
```

Same **phase ablation** as nightly reflect: `/workspace/group/dream-phases.json`, env `NANOCLAW_DREAM_LIGHT` / `REM` / `DEEP`, or a line `[nano-claw:dream-phases] {"rem":false}` anywhere in the prompt. See [nightly-reflect.md](nightly-reflect.md#dream-phases-ablation-light--rem--deep).

## What runs (deterministic)

| Phase | Writes / updates | Purpose |
|--------|------------------|---------|
| **Light** | `.dreams/short-term.json` | Ingests chunks from recent `conversations/*.md`, merges near-duplicates (Jaccard), tracks recall and simple concept tags, cross-agent flags when Andy and Bob both touched similar text in the shared group store. |
| **REM** | `.dreams/rem-snapshot.json` | Theme counts from tags, candidate entry ids, cross-agent agreement count. |
| **Deep** | `MEMORY.md`, `DREAMS.md`, `/workspace/common/memory/promotion-log.jsonl` | Weighted score + gates; appends up to 5 bullets per sweep under `## Durable memories`; prepends a diary section; logs JSON lines for audit. |

Then the **model** receives a **machine summary** and writes a short **Dream digest** in chat.

## Files (group workspace)

Paths are under the mounted group directory (`/workspace/group/` in the container):

- `MEMORY.md` — human-readable durable bullets (loaded into **every** session system prompt when present).
- `DREAMS.md` — prepend-only dream diary for humans.
- `.dreams/short-term.json` — staged candidates (machine).
- `.dreams/rem-snapshot.json` — last REM snapshot (machine).

Shared audit log:

- `/workspace/common/memory/promotion-log.jsonl` (host `common/memory/`).

## Example scheduled prompt

```text
[nano-claw:dreaming]
[nano-claw:dream-phases] light=true rem=true deep=true

(Optional) Emphasize research workflow lessons in the digest.
```

## Promotion gates (defaults)

Tunable later in `dreaming.ts`: approximate **score >= 0.72**, **recall >= 2**, at least **one** source archive id in `recall_queries`, max **5** promotions per sweep, entries older than **45** days pruned from short-term (by last recall / created).

## Script tasks

If a scheduled task uses a **script** that replaces the user prompt, the dreaming appendix is **not** re-applied on that branch (same caveat as nightly reflect). Prefer **prompt-only** dreaming tasks unless you extend the runner.

## Rebuild

After changing `agent-runner`, rebuild the container image for Andy and/or Bob.
