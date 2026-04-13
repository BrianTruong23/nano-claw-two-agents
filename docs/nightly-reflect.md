# Nightly reflect (`reflect.md` + overnight digest)

Andy and Bob's **container agent-runner** treats scheduled tasks specially when the task `prompt` **starts** (after trim) with:

```text
[nano-claw:overnight-reflect]
```

On those runs the host:

1. Injects a **Nightly reflect** section into the **system** prompt (content depends on which dream phases are ON; see below).
2. Appends **recent conversation archives** when **Light** is ON (newest few `*.md` files under `/workspace/group/conversations/`) plus **overnight duties** into the **user** task prompt (before the usual `[SCHEDULED TASK - ù]` wrapper).

The model is steered (per enabled phase) to ingest signals, reflect on patterns, merge bullets into `/workspace/group/reflect.md`, optionally update `/workspace/global/reflect.md`, suggest composite tools, and post an **Overnight digest**.

`reflect.md` is already loaded on every turn into the system prompt as tool-use reflection, so lessons accumulate for daytime chats.

For **durable user memory** (`MEMORY.md`) and the three-phase **deterministic** pipeline, see [dreaming.md](dreaming.md) (`[nano-claw:dreaming]`).

## Dream phases (ablation: Light / REM / Deep)

Work is split so you can disable any stage for experiments:

| Phase | When ON | When OFF |
|--------|-----------|----------|
| **Light** | Attach conversation archive snippets; ingest signals from them. | No archive block; model must not rely on snippets. |
| **REM** | Theme/pattern reflection before durable writes. | Skip that reflection; Deep may still run with minimal scope if ON. |
| **Deep** | Edit `reflect.md` / optional global `reflect.md`, overnight digest. | No file writes for consolidation, no Overnight digest. |

**Defaults:** all three ON (same behavior as before this feature).

**Merge order** (later overrides earlier): `/workspace/group/dream-phases.json` -> container env `NANOCLAW_DREAM_LIGHT`, `NANOCLAW_DREAM_REM`, `NANOCLAW_DREAM_DEEP` -> a line anywhere in the scheduled prompt matching `[nano-claw:dream-phases] ù`.

### `/workspace/group/dream-phases.json`

```json
{
  "light": true,
  "rem": false,
  "deep": true
}
```

Invalid JSON is ignored (logged in the agent-runner).

### Environment (passed through from host)

Set in the process that starts the container (values: `1`/`0`, `true`/`false`, `on`/`off`, case-insensitive):

- `NANOCLAW_DREAM_LIGHT`
- `NANOCLAW_DREAM_REM`
- `NANOCLAW_DREAM_DEEP`

### Prompt line (per scheduled task)

After the overnight marker, add a line such as:

```text
[nano-claw:overnight-reflect]
[nano-claw:dream-phases] {"light": true, "rem": false, "deep": true}
```

Or key=value:

```text
[nano-claw:dream-phases] light=1 rem=0 deep=1
```

If **all three** are OFF, the run is a no-op consolidation pass unless the rest of the prompt assigns explicit work.

## Scheduler vs `heartbeat.md`

- **Reliable wake-up:** add a row in **`scheduled_tasks`** (cron or interval) per bot database (`andy` / `bob` each have their own SQLite). The task runner sets `isScheduledTask: true` and streams the assistant reply to `chat_jid`.
- **`heartbeat.md`:** still attached to the system prompt on every run (group + global). You can keep a one-line reminder there for humans, but **the scheduled task is what actually fires on a clock**.

## Example task prompt

Use the marker on the **first line**; optional phase line and extra chores **below**:

```text
[nano-claw:overnight-reflect]
[nano-claw:dream-phases] rem=false

(Optional) Also skim /workspace/group/user.md for stale notes.
```

## Example `INSERT` (adjust IDs, JID, folder, timestamps)

Replace placeholders with your group's `folder` from `registered_groups`, the target `chat_jid`, and a new UUID for `id`. `next_run` must be an ISO-8601 time in the future for the scheduler to pick it up.

```sql
INSERT INTO scheduled_tasks (
  id, group_folder, chat_jid, prompt, script,
  schedule_type, schedule_value, context_mode,
  next_run, status, created_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'your-group-folder',
  'your-chat@example.com',
  '[nano-claw:overnight-reflect]',
  NULL,
  'cron',
  '0 7 * * *',
  'group',
  '2026-04-13T07:00:00.000Z',
  'active',
  datetime('now')
);
```

- **`context_mode`:** `group` vs `isolated` follows your deployment's usual scheduled-task semantics.
- **Both bots:** if you want **Andy** and **Bob** each to reflect, create **two** tasks in **each** bot's DB (or only attach the task to the bot that should speak in that `chat_jid`).

## Script + scheduled tasks

If a task has a **`script`** that returns `wakeAgent: true`, the runner **replaces** the prompt with script output + the **raw** stored `prompt`. The nightly archive appendix is **not** re-applied on that branch. For overnight reflect, use **prompt-only** scheduled tasks unless you extend the runner to merge script output with the nightly appendix.

## After changing agent-runner

Rebuild or restart the **agent-runner** container images so the updated `index.ts` is in the image.
