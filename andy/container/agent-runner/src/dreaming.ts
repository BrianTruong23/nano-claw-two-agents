/**
 * Dreaming: Light -> REM -> Deep memory consolidation for NanoClaw agent-runner.
 * Deterministic phases write `.dreams/*`, `MEMORY.md`, `DREAMS.md`, and a shared promotion log.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface DreamPhases {
  light: boolean;
  rem: boolean;
  deep: boolean;
}

export interface ShortTermEntry {
  id: string;
  text: string;
  source_agent: 'andy' | 'bob' | 'unknown';
  source_type: 'daily' | 'session' | 'recall' | 'correction';
  created_at: string;
  recall_count: number;
  recall_queries: string[];
  concept_tags: string[];
  confidence: number;
  cross_agent_confirmed: boolean;
  last_recalled_at: string;
}

export interface DreamingPipelineReport {
  sweepId: string;
  startedAt: string;
  completedAt: string;
  light?: { filesRead: number; newOrUpdated: number; totalShortTerm: number };
  rem?: {
    themeCount: number;
    topThemes: string[];
    candidateCount: number;
    crossAgentAgreements: number;
  };
  deep?: { promoted: string[]; rejected: number; cappedAt: number };
  diaryText: string;
  /** Injected under the scheduled prompt for the model to narrate / align with. */
  machineSummaryMarkdown: string;
}

const STOPWORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'have',
  'been',
  'were',
  'will',
  'your',
  'their',
  'about',
  'which',
  'when',
  'what',
  'would',
  'could',
  'should',
  'there',
  'these',
  'those',
  'into',
  'than',
  'then',
  'them',
  'some',
  'very',
  'just',
  'like',
  'also',
  'only',
  'user',
  'assistant',
]);

const PROMOTION_GATES = {
  minScore: 0.72,
  minRecallCount: 2,
  minUniqueQueries: 1,
  maxAgeDays: 45,
  maxPromotionsPerSweep: 5,
} as const;

const SCORING_WEIGHTS = {
  relevance: 0.28,
  frequency: 0.24,
  query_diversity: 0.16,
  recency: 0.16,
  consolidation: 0.1,
  conceptual_richness: 0.06,
} as const;

function dreamingLog(msg: string): void {
  console.error(`[dreaming] ${msg}`);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenizeConceptTags(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [];
  const tags: string[] = [];
  for (const w of raw) {
    if (STOPWORDS.has(w)) continue;
    tags.push(w);
  }
  return [...new Set(tags)].slice(0, 12);
}

function mapAssistant(agent: string): 'andy' | 'bob' | 'unknown' {
  const a = agent.toLowerCase();
  if (a.includes('bob')) return 'bob';
  if (a.includes('andy')) return 'andy';
  return 'unknown';
}

function normalizeShortTermEntry(raw: unknown): ShortTermEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== 'string' || typeof o.id !== 'string') return null;
  const now = new Date().toISOString();
  return {
    id: o.id,
    text: o.text,
    source_agent:
      o.source_agent === 'andy' || o.source_agent === 'bob' || o.source_agent === 'unknown'
        ? o.source_agent
        : 'unknown',
    source_type:
      o.source_type === 'daily' ||
      o.source_type === 'session' ||
      o.source_type === 'recall' ||
      o.source_type === 'correction'
        ? o.source_type
        : 'session',
    created_at: typeof o.created_at === 'string' ? o.created_at : now,
    recall_count: typeof o.recall_count === 'number' ? o.recall_count : 1,
    recall_queries: Array.isArray(o.recall_queries)
      ? (o.recall_queries as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    concept_tags: Array.isArray(o.concept_tags)
      ? (o.concept_tags as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    cross_agent_confirmed: Boolean(o.cross_agent_confirmed),
    last_recalled_at: typeof o.last_recalled_at === 'string' ? o.last_recalled_at : now,
  };
}

function readShortTermStore(storePath: string): ShortTermEntry[] {
  const raw = readJsonArray<unknown>(storePath, []);
  const out: ShortTermEntry[] = [];
  for (const item of raw) {
    const e = normalizeShortTermEntry(item);
    if (e) out.push(e);
  }
  return out;
}

function readJsonArray<T>(filePath: string, fallback: T[]): T[] {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch (e) {
    dreamingLog(`readJsonArray ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readOptionalUtf8(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function extractChunksFromArchive(markdown: string, sourceLabel: string): string[] {
  const chunks: string[] = [];
  const blocks = markdown.split(/\n{2,}/);
  for (const block of blocks) {
    const t = block.replace(/\*\*[^*]+:\*\*\s*/g, ' ').trim();
    if (t.length < 50 || t.length > 900) continue;
    if (/^#+\s/.test(t)) continue;
    chunks.push(t.slice(0, 800));
  }
  if (chunks.length === 0 && markdown.length > 50) {
    chunks.push(markdown.slice(0, 600));
  }
  return chunks.map((c) => `[${sourceLabel}] ${c}`);
}

function lightPhase(
  phases: DreamPhases,
  ctx: {
    groupDir: string;
    conversationsDir: string;
    assistantName: string;
  },
): DreamingPipelineReport['light'] {
  if (!phases.light) return undefined;

  const dreamsDir = path.join(ctx.groupDir, '.dreams');
  ensureDir(dreamsDir);
  const storePath = path.join(dreamsDir, 'short-term.json');
  let entries = readShortTermStore(storePath);

  let filesRead = 0;
  let newOrUpdated = 0;

  if (fs.existsSync(ctx.conversationsDir)) {
    const files = fs
      .readdirSync(ctx.conversationsDir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => {
        const full = path.join(ctx.conversationsDir, n);
        return { n, t: fs.statSync(full).mtimeMs, full };
      })
      .sort((a, b) => b.t - a.t)
      .slice(0, 10);

    const agent = mapAssistant(ctx.assistantName);
    const now = new Date().toISOString();

    for (const { n, full } of files) {
      filesRead++;
      const md = fs.readFileSync(full, 'utf8');
      const chunks = extractChunksFromArchive(md, n);
      for (const text of chunks) {
        const norm = text.replace(/\s+/g, ' ').trim();
        if (norm.length < 40) continue;

        let merged = false;
        for (const e of entries) {
          if (jaccardSimilarity(e.text, norm) >= 0.88) {
            e.recall_count += 1;
            e.last_recalled_at = now;
            if (!e.recall_queries.includes(n)) e.recall_queries.push(n);
            e.concept_tags = [...new Set([...e.concept_tags, ...tokenizeConceptTags(norm)])];
            e.confidence = Math.min(0.95, e.confidence + 0.03);
            if (e.source_agent !== agent && agent !== 'unknown' && e.source_agent !== 'unknown') {
              e.cross_agent_confirmed = true;
            }
            merged = true;
            newOrUpdated++;
            break;
          }
        }
        if (!merged) {
          entries.push({
            id: randomUUID(),
            text: norm,
            source_agent: agent,
            source_type: 'session',
            created_at: now,
            recall_count: 1,
            recall_queries: [n],
            concept_tags: tokenizeConceptTags(norm),
            confidence: 0.52,
            cross_agent_confirmed: false,
            last_recalled_at: now,
          });
          newOrUpdated++;
        }
      }
    }
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.source_agent === b.source_agent) continue;
      if (a.source_agent === 'unknown' || b.source_agent === 'unknown') continue;
      if (jaccardSimilarity(a.text, b.text) >= 0.62) {
        a.cross_agent_confirmed = true;
        b.cross_agent_confirmed = true;
      }
    }
  }

  entries.sort(
    (x, y) => new Date(y.last_recalled_at).getTime() - new Date(x.last_recalled_at).getTime(),
  );
  entries = entries.slice(0, 220);
  writeJson(storePath, entries);

  return {
    filesRead,
    newOrUpdated,
    totalShortTerm: entries.length,
  };
}

interface RemSnapshot {
  generated_at: string;
  themes: { tag: string; count: number }[];
  candidate_ids: string[];
  cross_agent_agreements: number;
}

function remPhase(
  phases: DreamPhases,
  ctx: { groupDir: string },
  entries: ShortTermEntry[],
): { snapshot: RemSnapshot; report: NonNullable<DreamingPipelineReport['rem']> } | undefined {
  if (!phases.rem) return undefined;

  const windowMs = 7 * 86400000;
  const now = Date.now();
  const recent = entries.filter((e) => {
    const t = new Date(e.last_recalled_at || e.created_at).getTime();
    return now - t <= windowMs;
  });

  const tagFreq: Record<string, number> = {};
  for (const e of recent) {
    for (const t of e.concept_tags) {
      tagFreq[t] = (tagFreq[t] || 0) + 1;
    }
  }
  const themes = Object.entries(tagFreq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([tag, count]) => ({ tag, count }));

  const candidate_ids = recent
    .filter((e) => e.recall_count >= 2 && e.confidence >= 0.48)
    .sort((a, b) => b.recall_count - a.recall_count)
    .slice(0, 40)
    .map((e) => e.id);

  const crossAgentAgreements = recent.filter(
    (e) => candidate_ids.includes(e.id) && e.cross_agent_confirmed,
  ).length;

  const snapshot: RemSnapshot = {
    generated_at: new Date().toISOString(),
    themes,
    candidate_ids,
    cross_agent_agreements: crossAgentAgreements,
  };

  const dreamsDir = path.join(ctx.groupDir, '.dreams');
  ensureDir(dreamsDir);
  writeJson(path.join(dreamsDir, 'rem-snapshot.json'), snapshot);

  return {
    snapshot,
    report: {
      themeCount: themes.length,
      topThemes: themes.slice(0, 8).map((t) => t.tag),
      candidateCount: candidate_ids.length,
      crossAgentAgreements: crossAgentAgreements,
    },
  };
}

function ageRecencyScore(entry: ShortTermEntry): number {
  const ageMs = Date.now() - new Date(entry.created_at).getTime();
  const maxMs = PROMOTION_GATES.maxAgeDays * 86400000;
  const r = Math.min(1, ageMs / Math.max(maxMs, 1));
  return Math.exp(-2.5 * r);
}

function computeScore(entry: ShortTermEntry): { total: number } {
  const relevance = Math.min(1, entry.concept_tags.length / 6);
  const frequency = Math.min(1, entry.recall_count / 15);
  const query_diversity = Math.min(1, entry.recall_queries.length / 5);
  const recency = ageRecencyScore(entry);
  const consolidation = entry.cross_agent_confirmed ? 0.85 : 0.45;
  const conceptual_richness = Math.min(1, entry.concept_tags.length / 8);
  const cross_agent_bonus = entry.cross_agent_confirmed ? 0.05 : 0;

  const total =
    SCORING_WEIGHTS.relevance * relevance +
    SCORING_WEIGHTS.frequency * frequency +
    SCORING_WEIGHTS.query_diversity * query_diversity +
    SCORING_WEIGHTS.recency * recency +
    SCORING_WEIGHTS.consolidation * consolidation +
    SCORING_WEIGHTS.conceptual_richness * conceptual_richness +
    cross_agent_bonus;

  return { total };
}

function memoryLinesAlreadyHasSimilar(memoryBody: string, text: string): boolean {
  const bullets = memoryBody.split('\n').filter((l) => /^[-*]\s/.test(l.trim()));
  for (const line of bullets) {
    if (jaccardSimilarity(line, text) >= 0.82) return true;
  }
  return jaccardSimilarity(memoryBody, text) >= 0.9;
}

type DeepPhaseResult = NonNullable<DreamingPipelineReport['deep']> & {
  promotedLines: string[];
  diaryLines: string[];
};

function deepPhase(
  phases: DreamPhases,
  ctx: { groupDir: string; commonDir: string },
  entries: ShortTermEntry[],
  candidateIds: string[],
): DeepPhaseResult {
  if (!phases.deep) {
    return {
      promoted: [],
      rejected: 0,
      cappedAt: PROMOTION_GATES.maxPromotionsPerSweep,
      promotedLines: [],
      diaryLines: [],
    };
  }

  const memoryPath = path.join(ctx.groupDir, 'MEMORY.md');
  const dreamsPath = path.join(ctx.groupDir, 'DREAMS.md');
  const commonMemDir = path.join(ctx.commonDir, 'memory');
  ensureDir(commonMemDir);
  const promoLogPath = path.join(commonMemDir, 'promotion-log.jsonl');

  let memoryBody = readOptionalUtf8(memoryPath) || '';
  if (!memoryBody.includes('## Durable memories')) {
    memoryBody =
      '# MEMORY\n\n## Durable memories\n\n' +
      (memoryBody.trim() ? `${memoryBody.trim()}\n\n` : '');
  }

  const idToEntry = new Map(entries.map((e) => [e.id, e]));
  const promoted: string[] = [];
  const promotedLines: string[] = [];
  let rejected = 0;
  const nowIso = new Date().toISOString();

  const candidates: ShortTermEntry[] = [];
  for (const id of candidateIds) {
    const e = idToEntry.get(id);
    if (e) candidates.push(e);
  }
  if (candidates.length === 0) {
    for (const e of entries) {
      if (e.recall_count >= 2) candidates.push(e);
    }
  }

  const scored = candidates
    .map((e) => ({ e, ...computeScore(e) }))
    .sort((a, b) => b.total - a.total);

  for (const { e, total } of scored) {
    if (promoted.length >= PROMOTION_GATES.maxPromotionsPerSweep) break;

    const ageMs = Date.now() - new Date(e.created_at).getTime();
    if (ageMs > PROMOTION_GATES.maxAgeDays * 86400000) {
      rejected++;
      continue;
    }

    if (total < PROMOTION_GATES.minScore) {
      rejected++;
      continue;
    }
    if (e.recall_count < PROMOTION_GATES.minRecallCount) {
      rejected++;
      continue;
    }
    if (e.recall_queries.length < PROMOTION_GATES.minUniqueQueries) {
      rejected++;
      continue;
    }

    const oneLine = e.text.replace(/\s+/g, ' ').trim().slice(0, 280);
    if (memoryLinesAlreadyHasSimilar(memoryBody, oneLine)) {
      rejected++;
      continue;
    }

    const agents =
      e.source_agent === 'unknown' ? 'agent' : e.source_agent + (e.cross_agent_confirmed ? '+peer' : '');
    const line = `- ${oneLine} [score:${total.toFixed(2)}, ${agents}, ${nowIso.slice(0, 10)}]`;
    promoted.push(oneLine);
    promotedLines.push(line);
    memoryBody = memoryBody.trimEnd() + '\n' + line + '\n';
  }

  if (promotedLines.length > 0) {
    fs.writeFileSync(memoryPath, memoryBody, 'utf8');
  }

  const diaryLines: string[] = [
    `## Dream diary ù ${nowIso.slice(0, 10)} ${nowIso.slice(11, 19)}Z`,
    '',
    `- **Deep:** promoted ${promoted.length}, rejected ${rejected} (gates: score>=${PROMOTION_GATES.minScore}, recall>=${PROMOTION_GATES.minRecallCount}).`,
  ];
  if (promoted.length > 0) {
    diaryLines.push('', '**Promoted:**', ...promoted.map((p) => `- ${p}`));
  }
  const diaryText = diaryLines.join('\n') + '\n\n---\n\n';
  const existingDreams = readOptionalUtf8(dreamsPath) || '';
  fs.writeFileSync(dreamsPath, diaryText + existingDreams, 'utf8');

  const logLine = JSON.stringify({
    at: nowIso,
    promoted: promoted.length,
    rejected,
    lines: promoted.slice(0, 5),
  });
  fs.appendFileSync(promoLogPath, logLine + '\n', 'utf8');

  const storePath = path.join(ctx.groupDir, '.dreams', 'short-term.json');
  const maxAge = PROMOTION_GATES.maxAgeDays * 86400000;
  const pruned = entries.filter(
    (e) => Date.now() - new Date(e.last_recalled_at || e.created_at).getTime() <= maxAge,
  );
  if (pruned.length !== entries.length) {
    writeJson(storePath, pruned);
  }

  return {
    promoted,
    rejected,
    cappedAt: PROMOTION_GATES.maxPromotionsPerSweep,
    promotedLines,
    diaryLines,
  };
}

export const DREAMING_MARKER = /^\s*\[nano-claw:dreaming\]/i;

export function isDreamingPrompt(raw: string | undefined): boolean {
  if (!raw) return false;
  return DREAMING_MARKER.test(raw.trim());
}

export function runDreamingPipeline(
  phases: DreamPhases,
  ctx: {
    groupDir: string;
    commonDir: string;
    conversationsDir: string;
    assistantName: string;
  },
): DreamingPipelineReport {
  const sweepId = randomUUID();
  const startedAt = new Date().toISOString();
  const light = lightPhase(phases, {
    groupDir: ctx.groupDir,
    conversationsDir: ctx.conversationsDir,
    assistantName: ctx.assistantName,
  });

  const storePath = path.join(ctx.groupDir, '.dreams', 'short-term.json');
  let entries = readShortTermStore(storePath);

  const remOut = remPhase(phases, { groupDir: ctx.groupDir }, entries);
  const rem = remOut?.report;
  const candidateIds = remOut?.snapshot.candidate_ids ?? [];

  entries = readShortTermStore(storePath);
  const deepResult = deepPhase(phases, { groupDir: ctx.groupDir, commonDir: ctx.commonDir }, entries, candidateIds);

  const completedAt = new Date().toISOString();

  const machineParts: string[] = [
    '## Machine dreaming report (host-computed)',
    '',
    `- **Sweep:** \`${sweepId}\` ù ${startedAt} -> ${completedAt}`,
    `- **Phases run:** Light=${phases.light ? 'yes' : 'skipped'}, REM=${phases.rem ? 'yes' : 'skipped'}, Deep=${phases.deep ? 'yes' : 'skipped'}`,
  ];
  if (light) {
    machineParts.push(
      `- **Light:** conversation files read=${light.filesRead}, signals merged/new=${light.newOrUpdated}, short-term entries=${light.totalShortTerm}`,
    );
  }
  if (rem) {
    machineParts.push(
      `- **REM:** themes=${rem.themeCount} (e.g. ${rem.topThemes.join(', ') || 'n/a'}), candidates=${rem.candidateCount}, cross-agent agreements=${rem.crossAgentAgreements}`,
    );
  }
  if (phases.deep && deepResult) {
    machineParts.push(
      `- **Deep:** promoted=${deepResult.promoted.length} (cap ${deepResult.cappedAt}/sweep), rejected=${deepResult.rejected}`,
    );
    if (deepResult.promoted.length > 0) {
      machineParts.push(
        '',
        '**Promoted one-liners (already written to MEMORY.md):**',
        ...deepResult.promoted.map((p) => `- ${p}`),
      );
    }
  }

  const diaryText =
    (deepResult?.diaryLines?.length ? deepResult.diaryLines.join('\n') : '') ||
    `## Dream diary ù ${completedAt.slice(0, 10)}\n_(no Deep writes this run)_\n`;

  const machineSummaryMarkdown = machineParts.join('\n');

  return {
    sweepId,
    startedAt,
    completedAt,
    light,
    rem,
    deep: phases.deep
      ? {
          promoted: deepResult.promoted,
          rejected: deepResult.rejected,
          cappedAt: deepResult.cappedAt,
        }
      : undefined,
    diaryText,
    machineSummaryMarkdown,
  };
}

function formatDreamPhasesLine(phases: DreamPhases): string {
  return `**Dream phases:** Light=${phases.light ? 'ON' : 'OFF'}, REM=${phases.rem ? 'ON' : 'OFF'}, Deep=${phases.deep ? 'ON' : 'OFF'}`;
}

export function buildDreamingSystemAddendum(phases: DreamPhases): string {
  const lines = [
    '# Dreaming (scheduled)',
    '- This pass runs **Light -> REM -> Deep** in the container (deterministic), then you interpret results for the user.',
    `- ${formatDreamPhasesLine(phases)} ù skipped phases were not executed by the host.`,
    '- **Light:** ingests conversation archives into `.dreams/short-term.json` (user needs + self-improvement signals).',
    '- **REM:** clusters tags, marks cross-agent reinforcement, writes `.dreams/rem-snapshot.json`.',
    '- **Deep:** scores candidates, appends durable lines to `/workspace/group/MEMORY.md`, appends a section to `DREAMS.md`, and logs to `/workspace/common/memory/promotion-log.jsonl`.',
    '- Reply in chat with a short **Dream digest**: what was promoted, top themes, and one suggestion for tomorrow. If nothing promoted, say so plainly.',
    '- Do **not** contradict the machine report; you may clarify and prioritize for the user.',
    '- Optional: if you see a **tool-use** lesson (not a user fact), mention it for `reflect.md` but only edit `reflect.md` if the user prompt below explicitly asks.',
  ];
  return lines.join('\n');
}

export function augmentDreamingUserPrompt(
  rawPrompt: string,
  phases: DreamPhases,
  report: DreamingPipelineReport,
): string {
  return [
    rawPrompt.trim(),
    '---',
    formatDreamPhasesLine(phases),
    '',
    report.machineSummaryMarkdown,
    '',
    '## Your task',
    'Write a concise **Dream digest** for the group (Markdown). Lead with user-relevant promoted memories if any, then themes, then self-improvement (tool/workflow) notes. Keep under ~400 words.',
  ].join('\n\n');
}
