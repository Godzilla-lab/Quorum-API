/*
 * The five tools.
 *
 * FIVE, NOT ONE PER ENDPOINT. A tool definition costs 100 to 500 tokens and an
 * agent pays for every one on every turn, so a server that mirrors ten HTTP
 * routes burns the context window before the model has done anything. Similar
 * operations collapse behind an action enum instead.
 *
 * AGGREGATED SERVER SIDE. `search_evidence` answers "how many, across how many
 * places, and here are the loudest few". It never streams the corpus into a
 * context window, because a raw row dump is how a research tool turns a
 * 200,000 token budget into nothing.
 *
 * MARKDOWN OUT, NOT JSON. Measured elsewhere in this repo at roughly 60% of the
 * tokens for the same content. Every response still carries receipt ids,
 * because the entire pitch is that the calling agent can check us.
 */

import { corroborate, formatVerdict, adsForVerdict, type Corroboration } from '@quorum/core';
import type { CorpusDriver, Doc } from '@quorum/corpus';
import type { ToolDefinition } from './protocol.ts';

/* How many records a tool will quote. Small on purpose: the counts are the
 * answer and the quotes are evidence for it, so a handful is persuasive and a
 * hundred is a denial of service against the caller's own context. */
const QUOTED = 5;
/* How many receipt ids to list beyond the quoted ones, so an agent can fetch
 * more without a second search. */
const LISTED_IDS = 20;

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, n));
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/* One line per record, with its id, so a claim and the way to check it never
 * get separated. Excerpts are bounded because a single Reddit post can be
 * thousands of words. */
function quote(doc: Doc, maxChars = 240): string {
  const text = doc.text.replace(/\s+/g, ' ').trim();
  const excerpt = text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  return `> ${excerpt}\n> \n> \`${doc.receiptId}\` ${doc.source} ${doc.channel}`;
}

function corroborationLine(c: Corroboration): string {
  return c.verdict === 'finding'
    ? `**Finding.** ${c.records} independent records across ${c.channels} channels, threshold ${c.threshold}.`
    : `**Weak signal, not a finding.** ${c.records} records across ${c.channels} channels, `
      + `and the threshold is ${c.threshold}. Do not state this as a market pattern.`;
}

export interface ToolDeps {
  /* Injected so every tool is testable against a temp corpus with no network,
   * and so the same tools can later sit over the hosted API instead. */
  corpus: CorpusDriver;
  /*
   * Runs a full report. Absent when the server is started read only, which is
   * the safe default: a report is minutes of throttled upstream retrieval and
   * an agent should not be able to start one by accident.
   */
  research?: (subject: string, terms: string[]) => Promise<string>;
}

export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { corpus } = deps;

  const searchEvidence: ToolDefinition = {
    name: 'search_evidence',
    annotations: { title: 'Search the evidence corpus', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Search the retained corpus for what people actually said about a product or topic. '
      + 'Returns how many independent records exist, across how many channels, whether that '
      + 'clears the corroboration threshold, and the loudest few quotes with their receipt ids. '
      + 'Costs nothing and touches no network.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for: "sizing", "battery life", "runs small".' },
        category: { type: 'string', description: 'Optional. Narrow to one product category.' },
        limit: { type: 'number', description: 'Records to count over. Default 200, max 500.' },
      },
      required: ['query'],
    },
    async run(args) {
      const query = str(args['query']);
      if (!query) return 'No query given. Pass something to search for.';
      const category = str(args['category']);
      const limit = clampLimit(args['limit'], 200, 500);

      const hits = await corpus.search(query, {
        limit,
        ...(category ? { category } : {}),
      });

      if (!hits.length) {
        /*
         * ABSENCE IS AN ANSWER AND IS SAID AS ONE. "No records" invites a model
         * to conclude the problem does not exist. It means we hold nothing.
         */
        return `No records held for ${JSON.stringify(query)}`
          + `${category ? ` in ${JSON.stringify(category)}` : ''}.\n\n`
          + 'That means the corpus holds nothing on it, which is not evidence that it is fine. '
          + 'Check `category_warmth` to see whether this category has been harvested at all.';
      }

      const c = corroborate(query, hits);
      const out: string[] = [];
      out.push(`## ${query}${category ? ` in ${category}` : ''}`);
      out.push('');
      out.push(corroborationLine(c));
      out.push('');
      for (const doc of hits.slice(0, QUOTED)) {
        out.push(quote(doc));
        out.push('');
      }
      const rest = c.receiptIds.slice(QUOTED, QUOTED + LISTED_IDS);
      if (rest.length) {
        out.push(`More receipts: ${rest.map((id) => `\`${id}\``).join(' ')}`);
        if (c.receiptIds.length > QUOTED + LISTED_IDS) {
          out.push(`...and ${c.receiptIds.length - QUOTED - LISTED_IDS} more.`);
        }
        out.push('');
      }
      out.push('Resolve any id with `get_receipt` to read the whole record.');
      return out.join('\n');
    },
  };

  const getReceipt: ToolDefinition = {
    name: 'get_receipt',
    annotations: { title: 'Resolve receipt ids', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Resolve receipt ids to the real records behind them. This is how you CHECK a claim: '
      + 'if an id does not resolve, the claim citing it was not real. Takes one id or many.',
    inputSchema: {
      type: 'object',
      properties: {
        receiptIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Receipt ids, as returned by any other tool. Up to 50.',
        },
      },
      required: ['receiptIds'],
    },
    async run(args) {
      const raw = args['receiptIds'];
      const ids = (Array.isArray(raw) ? raw : [raw])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim())
        .slice(0, 50);
      if (!ids.length) return 'No receipt ids given.';

      const found = await corpus.getByReceiptIds(ids);
      const byId = new Map(found.map((d) => [d.receiptId, d]));
      const out: string[] = [];

      /*
       * THE UNRESOLVED ARE NAMED FIRST AND LOUDLY. An id that does not resolve
       * is the single most important thing this server can tell a model, and
       * burying it under the ones that did resolve is how it gets missed.
       */
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) {
        out.push(`**${missing.length} of ${ids.length} ids did not resolve.** `
          + 'Any claim resting on these is unsupported and must not be repeated:');
        for (const id of missing) out.push(`- \`${id}\``);
        out.push('');
      }

      for (const id of ids) {
        const doc = byId.get(id);
        if (!doc) continue;
        const when = doc.createdUtc ? new Date(doc.createdUtc * 1000).toISOString().slice(0, 10) : 'undated';
        out.push(`### \`${doc.receiptId}\``);
        out.push(`${doc.source} / ${doc.channel} / ${when}${doc.url ? ` / ${doc.url}` : ''}`);
        out.push('');
        out.push(doc.text.replace(/\s+/g, ' ').trim());
        out.push('');
      }
      return out.join('\n').trim();
    },
  };

  const categoryWarmth: ToolDefinition = {
    name: 'category_warmth',
    annotations: { title: 'Check category warmth', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'How much is already held for a category, and therefore whether asking about it is '
      + 'instant and free or slow and expensive. Check this BEFORE starting a report.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'The category, for example "running shoes".' } },
      required: ['category'],
    },
    async run(args) {
      const category = str(args['category']);
      if (!category) return 'No category given.';
      const stats = await corpus.categoryStats(category);

      if (!stats.docs) {
        return `Nothing held for ${JSON.stringify(category)}.\n\n`
          + 'A report on it would be a cold run: minutes of throttled retrieval against '
          + 'upstream archives. Worth doing once, and instant every time after.';
      }
      const age = stats.ageDays === null ? 'unknown age' : `last harvested ${stats.ageDays.toFixed(1)} days ago`;
      return `## ${category}\n\n`
        + `${stats.docs} records across ${stats.channels} channels, ${age}.\n\n`
        + (stats.warm
          ? '**Warm.** Answering from this costs no upstream requests and returns in well under a second.'
          : '**Cold.** Held records are usable, but a fresh report would retrieve again, '
            + 'which takes minutes and puts load on volunteer archives.');
    },
  };

  const compareFormats: ToolDefinition = {
    name: 'compare_formats',
    annotations: { title: 'Compare ad formats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Video versus static advertising for a category, computed from how long real ads actually '
      + 'ran rather than from opinion. Returns a verdict, its confidence, and the ads behind it.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'The product category.' } },
      required: ['category'],
    },
    async run(args) {
      const category = str(args['category']);
      if (!category) return 'No category given.';

      const ads = await adsForVerdict(corpus, category);
      if (!ads.length) return `No ads held for ${JSON.stringify(category)}, so there is nothing to compare.`;

      const v = formatVerdict(ads);
      const out: string[] = [];
      out.push(`## ${category}: video versus static`);
      out.push('');
      out.push(v.verdict
        ? `**${v.verdict}**, ${v.confidence} confidence. ${v.reason}`
        /*
         * A null verdict is a real answer and says so. "We looked and there is
         * not enough to call it" is information; inventing a lean is not.
         */
        : `**No verdict.** ${v.reason}`);
      out.push('');
      out.push(`Sample: ${v.sample.ads} ads, ${v.sample.typed} with a readable creative type, `
        + `${v.sample.dated} dated.`);
      if (v.durationWeighted.videoShare !== null) {
        out.push(`Weighted by days actually run: ${(v.durationWeighted.videoShare * 100).toFixed(0)}% video.`);
      }
      return out.join('\n');
    },
  };

  const tools = [searchEvidence, getReceipt, categoryWarmth, compareFormats];

  /*
   * The only tool that can spend time or money, so it only exists when the
   * caller wired it. A read only server is the safe default and is still
   * useful: four of the five tools answer from what is already held.
   */
  if (deps.research) {
    const research = deps.research;
    tools.unshift({
      name: 'research_product',
      annotations: { title: 'Run a full report', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Run a full report on a product or topic: retrieve from public sources, corroborate, and '
        + 'return findings with receipts. SLOW AND EXPENSIVE on a cold category, minutes rather '
        + 'than seconds. Call `category_warmth` first to find out which one you are in.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'A product name, a topic, or a product URL.' },
          terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'What to ask about: single concepts like "sizing", "durability". Optional.',
          },
        },
        required: ['subject'],
      },
      async run(args) {
        const subject = str(args['subject']);
        if (!subject) return 'No subject given.';
        const raw = args['terms'];
        const terms = Array.isArray(raw)
          ? raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
          : [];
        return await research(subject, terms);
      },
    });
  }

  return tools;
}
