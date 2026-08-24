/*
 * Working out what a product name refers to.
 *
 * THE PROBLEM, MEASURED 2026-08-22.
 *
 * A bare product name finds nothing. "wool runner" guesses wool.com, matches
 * r/woolworths, and after the relevance fix correctly stores zero records:
 *
 *   wool runner                   0 of 3 guessed domains had a catalogue
 *   merino wool sneakers          0 of 3
 *   bamboo toothbrush             0 of 3
 *   magnesium glycinate gummies   0 of 3
 *
 * The missing ingredient is not a search engine. It is knowing that a wool
 * runner is a shoe made by Allbirds. Once you have the brand, everything
 * downstream already works: `findProductByName("Allbirds wool runner")` returns
 * the real product with a real price, proven live on the same day.
 *
 * A MODEL IS ALLOWED TO GUESS HERE, AND IT IS NOT ALLOWED TO BE BELIEVED.
 *
 * This is the same rule as vision, and it is the reason this file is safe. An
 * expansion is a SEARCH HINT. It decides where to look and never what is true:
 *
 *   - Nothing here becomes a record, a receipt, or part of a corroboration
 *     count. The return type has no receipt id and never touches the corpus.
 *   - Every brand it offers is then VERIFIED against a real public catalogue.
 *     A hallucinated brand fails that check and costs one request.
 *   - The relevance gate still runs against the SUBJECT THE USER TYPED, so an
 *     expansion cannot widen what counts as evidence. If the model says a wool
 *     runner is a sock, the sock records get gated out.
 *
 * So the worst case for a wrong guess is a wasted request, and the worst case
 * for a right one is that a niche product becomes researchable.
 *
 * CONTEXT TERMS ARE THE ONE PLACE EXPANSION TOUCHES THE GATE, AND ONLY TO
 * NARROW IT. A record whose own text never names the subject can pass the gate
 * on its container's word alone (a community name, a thread title). Measured
 * 2026-08-23: a "love" run stored 2544 of 2544 records seen, because r/love
 * vouched for reality TV chatter. Context terms are the vocabulary a buyer
 * actually uses about the product, and on a subject that weak, a vouched
 * record must show at least one of them in its own text. A wrong or missing
 * context list leaves the gate exactly as strict as it was; it can reject
 * more, never admit more. The scoping measurement lives in relevance.ts.
 */

import type { Env } from '@quorum/sources';
import { VISION_MODELS } from './vision.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/*
 * The same free models as vision. They are text capable too, and reusing the
 * list means one place to maintain when the free pool shifts, which it does.
 */
export const EXPANSION_MODELS = VISION_MODELS;

export interface SubjectExpansion {
  /* Companies that might make this. Verified against real catalogues after. */
  brands: string[];
  /* What kind of thing it is, in the words a buyer would use. */
  category: string | null;
  /* Other names for the same thing, for finding communities. */
  aliases: string[];
  /*
   * Words a buyer uses when actually discussing this product: actions,
   * attributes, complaint vocabulary. Used to demand that a record passing on
   * its container's word alone says SOMETHING about the subject itself. Only
   * ever tightens the gate. See the header.
   */
  context: string[];
  /* Which model said it, because a guess with no author is not checkable. */
  model: string;
  /* ALWAYS TRUE. This is a hint, never a fact. See the header. */
  derived: true;
}

export interface ExpansionResult {
  ok: boolean;
  expansion?: SubjectExpansion;
  error?: string;
}

/*
 * Asked for json and for restraint. A model that invents five plausible brands
 * costs five requests to disprove, so the prompt pushes it to say nothing
 * rather than to fill the field.
 */
const PROMPT = (subject: string): string =>
  'You are helping a market research tool decide where to look. '
  + `The user typed this product name: ${JSON.stringify(subject)}\n\n`
  + 'Reply with ONLY a JSON object, no prose and no code fence:\n'
  + '{"brands":[],"category":null,"aliases":[],"context":[]}\n\n'
  + 'brands: up to 3 companies that actually make a product by this name. '
  + 'If you are not confident, return an empty list. Do not guess.\n'
  + 'category: what kind of product this is, two or three words a shopper would '
  + 'use, or null if unclear.\n'
  + 'aliases: up to 3 other common names for the same kind of product.\n'
  + 'context: 10 to 20 single words a buyer uses when discussing this product, '
  + 'such as its parts, attributes, actions and common complaints. Words that '
  + 'would appear in a real customer comment about it, not marketing words.';

export interface ExpandOptions {
  model?: string;
  timeoutMs?: number;
  post: (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number })
    => Promise<{ ok: boolean; status: number; body: string; error?: string }>;
}

/*
 * 404 is in the list because the free pool drifts: on 2026-08-24 the first
 * model in EXPANSION_MODELS had been withdrawn from OpenRouter and every
 * expansion died on the first rung instead of trying the next. A model that
 * no longer exists is exactly the case the chain exists for.
 */
const WORTH_FAILING_OVER = new Set([402, 403, 404, 408, 429, 500, 502, 503, 504]);

/* Bounded hard. A model asked for three items will sometimes offer twelve, and
 * every extra brand is a real request to a stranger's host. */
const MAX_BRANDS = 3;
const MAX_ALIASES = 3;
/* Context terms cost nothing per term, but an unbounded list from a chatty
 * model would turn the vouched record requirement into "contains any common
 * word", which is no requirement at all. */
const MAX_CONTEXT = 20;

const strings = (v: unknown, limit: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 1)
      .map((x) => x.trim())
      .slice(0, limit)
    : [];

/*
 * Models wrap json in code fences roughly half the time however firmly they are
 * told not to. Stripping it is cheaper than a retry and cheaper than a parser.
 */
export function parseExpansion(raw: string, model: string): SubjectExpansion | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: { brands?: unknown; category?: unknown; aliases?: unknown; context?: unknown };
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as typeof parsed;
  } catch {
    return null;
  }

  const category = typeof parsed.category === 'string' && parsed.category.trim().length > 1
    ? parsed.category.trim()
    : null;

  const expansion: SubjectExpansion = {
    brands: strings(parsed.brands, MAX_BRANDS),
    category,
    aliases: strings(parsed.aliases, MAX_ALIASES),
    context: strings(parsed.context, MAX_CONTEXT),
    model,
    derived: true,
  };

  /* An expansion that suggests nothing is not an expansion. */
  if (!expansion.brands.length && !expansion.category && !expansion.aliases.length
    && !expansion.context.length) return null;
  return expansion;
}

export function expansionConfigured(env: Env): boolean {
  return Boolean(env['OPENROUTER_API_KEY']);
}

/* Never throws. Failing to expand costs a thinner report, never a run. */
export async function expandSubject(
  subject: string,
  env: Env,
  options: ExpandOptions,
): Promise<ExpansionResult> {
  /* Trimmed for the reason given in claims.ts: a pasted key carries a newline. */
  const key = env['OPENROUTER_API_KEY']?.trim();
  if (!key) return { ok: false, error: 'expansion not configured' };

  const models = options.model ? [options.model] : [...EXPANSION_MODELS];
  const attempts: string[] = [];

  for (const model of models) {
    const response = await options.post(ENDPOINT, {
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      timeoutMs: options.timeoutMs ?? 45_000,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROMPT(subject) }],
      }),
    });

    if (!response.ok) {
      attempts.push(`${model}: ${response.error ?? `status ${response.status}`}`);
      if (WORTH_FAILING_OVER.has(response.status)) continue;
      return { ok: false, error: attempts.join('; ') };
    }

    let content = '';
    try {
      const parsed = JSON.parse(response.body) as {
        choices?: { message?: { content?: unknown } }[];
        error?: { message?: unknown };
      };
      /* A 200 carrying an error means the gateway accepted and the provider
       * refused. See vision.ts for the measurement behind this. */
      if (parsed.error) { attempts.push(`${model}: ${String(parsed.error.message ?? 'provider error')}`); continue; }
      const raw = parsed.choices?.[0]?.message?.content;
      content = typeof raw === 'string' ? raw : '';
    } catch {
      attempts.push(`${model}: response was not json`);
      continue;
    }

    const expansion = parseExpansion(content, model);
    if (!expansion) { attempts.push(`${model}: no usable expansion`); continue; }
    return { ok: true, expansion };
  }

  return { ok: false, error: attempts.join('; ') || 'no model answered' };
}
