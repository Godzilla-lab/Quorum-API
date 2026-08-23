/*
 * The transport for synthesis.
 *
 * `synthesise` in core builds the evidence book, translates ordinals back into
 * receipt ids and never touches the network. This file is the half that talks
 * to a provider, and it exists separately for the reason every other split in
 * this repo exists: the part that decides what may be believed has to be
 * testable with no key and no wire.
 *
 * WHY A JSON SCHEMA IS SENT AND WHY THE ANSWER IS STILL PARSED BY HAND.
 *
 * MEASURED 2026-08-22 against the OpenRouter catalogue: 18 free models, and
 * only 5 of them advertise `structured_outputs`. Asked the real synthesis
 * question with no `response_format`, nvidia/nemotron-nano-12b-v2-vl:free
 * replied in markdown prose with bolded headings and bulleted quotes. It was a
 * perfectly good answer and it was not JSON, and a parser that assumed
 * otherwise would have reported the model as broken.
 *
 * So the schema is sent when we have it, and the response is treated as a
 * string that might contain JSON either way. A provider that honours the
 * schema costs nothing extra; a provider that ignores it degrades to a parse
 * rather than to a crash.
 *
 * THE FALLBACK LIST IS NOT AN OPTIMISATION.
 *
 * The free pool is shared and rate limited upstream. Measured on the same day,
 * google/gemma-4-31b-it:free returned 429 "temporarily rate-limited upstream"
 * on two consecutive calls a second apart. One pinned free model is therefore a
 * feature that works on a quiet afternoon, which is worse than no feature.
 */

import type { AskModel, ModelUsage } from '@receipts/core';
import type { Env } from '@receipts/sources';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/*
 * MEASURED LIVE 2026-08-22. Every free model advertising `structured_outputs`
 * was asked the real synthesis question over a six record evidence book, twice,
 * once with the schema and once without. What happened:
 *
 *   nvidia/nemotron-nano-9b-v2:free      200, 38s, valid claims, and it
 *                                        correctly REPORTED the injected record
 *                                        as something a commenter wrote
 *   z-ai/glm-5.2:free                    429 rate-limited upstream on both
 *                                        calls, so it is listed unproven
 *   liquid/lfm-2.5-2.6b:free             200, 3s, valid claims, and it OBEYED
 *                                        the prompt injection. Last on purpose
 *   nvidia/nemotron-3-super-120b-a12b    200 twice with an EMPTY body, having
 *                                        spent 1,096 output tokens. Excluded
 *   dots-studio/dots-3-note-preview      400 twice on a request every other
 *                                        model accepted. Excluded
 *
 * Order is by what was observed, not by parameter count. The model that obeyed
 * an injection is still in the list because the gate catches it and because a
 * three second answer is worth having when the others are rate limited, but it
 * is the last thing tried.
 *
 * A paid model is passed with --synthesis-model and charges the meter properly,
 * because it has a rate card. These do not, and the default path must cost a
 * self hoster nothing.
 */
export const CLAIMS_MODELS = [
  'nvidia/nemotron-nano-9b-v2:free',
  'z-ai/glm-5.2:free',
  'liquid/lfm-2.5-2.6b:free',
] as const;

/*
 * EVERY STATUS FAILS OVER TO THE NEXT MODEL HERE, WHICH IS A DELIBERATE
 * DIVERGENCE FROM vision.ts AND expand.ts.
 *
 * Those two stop on a 400, on the reasoning that a 400 is our mistake and
 * retrying it only burns the list. Measured 2026-08-22, that reasoning is
 * wrong for this call: dots-studio/dots-3-note-preview:free returned 400 twice
 * on a request body that two other models accepted and answered. A per model
 * 400 is a provider refusing, not us being wrong, and stopping the list on it
 * loses the whole feature to one broken upstream.
 *
 * The list is three long and bounded, so the worst case if our request really
 * is malformed is three wasted calls and an error carrying all three refusals,
 * which is more diagnostic than one.
 */

/*
 * Synthesis prompts are large: 300 records at up to 800 characters each is a
 * quarter of a megabyte of evidence, and a free model on a shared pool is slow.
 * Measured 2026-08-22, a six record book took 9.3s on the slowest model that
 * answered at all.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ClaimsTransport {
  (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }):
    Promise<{ ok: boolean; status: number; body: string; error?: string }>;
}

export interface ClaimsOptions {
  /* One model instead of the fallback list. Used by --synthesis-model. */
  model?: string;
  timeoutMs?: number;
  post: ClaimsTransport;
}

export function claimsConfigured(env: Env): boolean {
  return Boolean(env['OPENROUTER_API_KEY']);
}

/*
 * Pull a JSON object out of whatever the model actually returned.
 *
 * Models wrap json in a code fence roughly half the time however firmly they
 * are told not to, and a reasoning model prepends a sentence about what it is
 * about to do. Both are cheaper to strip than to retry. Returns null rather
 * than throwing, because a model writing prose is a degraded run and not a bug.
 */
export function parseModelJson(raw: string): unknown | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* OpenRouter reports usage in OpenAI's shape. Absent on some providers, and a
 * missing count is reported as missing rather than as zero. */
function usageFrom(payload: unknown): ModelUsage | undefined {
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}

/*
 * Build the `AskModel` that `synthesise` calls. Never throws: a provider being
 * down degrades a run, and the deterministic half of the report is unaffected.
 */
export function askClaims(env: Env, options: ClaimsOptions): AskModel {
  return async (request) => {
    const key = env['OPENROUTER_API_KEY'];
    if (!key) return { ok: false, error: 'synthesis not configured, set OPENROUTER_API_KEY' };

    const models = options.model ? [options.model] : [...CLAIMS_MODELS];
    const attempts: string[] = [];

    for (const model of models) {
      const response = await options.post(ENDPOINT, {
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          /* Sent whether or not the model honours it. See the header. */
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'claims', strict: true, schema: request.schema },
          },
        }),
      });

      if (!response.ok) {
        attempts.push(`${model}: ${response.error ?? `status ${response.status}`}`);
        continue;
      }

      let payload: { choices?: { message?: { content?: unknown } }[]; error?: { message?: unknown } };
      try {
        payload = JSON.parse(response.body) as typeof payload;
      } catch {
        attempts.push(`${model}: response was not json`);
        continue;
      }

      /*
       * A 200 carrying an error object means the gateway accepted the request
       * and the provider refused it. Measured in vision.ts and it happens on
       * the free pool constantly.
       */
      if (payload.error) {
        attempts.push(`${model}: ${String(payload.error.message ?? 'provider error')}`);
        continue;
      }

      const content = payload.choices?.[0]?.message?.content;
      const json = typeof content === 'string' ? parseModelJson(content) : null;
      if (json === null) {
        attempts.push(`${model}: answered without json`);
        continue;
      }

      const usage = usageFrom(payload);
      return { ok: true, json, model, ...(usage ? { usage } : {}) };
    }

    return { ok: false, error: attempts.join('; ') || 'no model answered' };
  };
}
