/*
 * Reading images.
 *
 * THE RULE THIS WHOLE FILE EXISTS TO ENFORCE:
 *
 *   THE IMAGE IS THE RECEIPT. WHAT A MODEL SAYS ABOUT IT IS AN INTERPRETATION.
 *
 * Everything else in this engine counts records, and a record is something a
 * human wrote that a reader can go and look at. A vision model's output is not
 * that. It is a plausible sentence generated about a picture, and if it were
 * allowed into the corroboration count then "31 independent records" would
 * silently include things nobody ever said.
 *
 * So the type here carries no receipt id, is never a `Doc`, and cannot reach
 * `addDocs`. An `ImageReading` attaches to a record that already exists, and
 * the url of the image it read travels with it so a reader can open the picture
 * and disagree. That is structural: there is no code path from this file into
 * evidence, and a test asserts it.
 *
 * TWO KINDS OF READING, AND THEY ARE NOT EQUALLY TRUSTWORTHY.
 *
 *   TRANSCRIPTION  the words printed in the image. This is extraction, not
 *                  opinion: the text is really there, and anyone can open the
 *                  image and check it character by character. For ad creative
 *                  it is the most valuable thing on the page, because a large
 *                  share of ad copy is baked into the picture where our text
 *                  parsing never sees it.
 *   DESCRIPTION    what the model thinks is depicted. Useful, and never
 *                  evidence.
 *
 * Both are marked, so a caller that wants only the defensible half can have it.
 *
 * WHY OPENROUTER. Measured 2026-08-22: nothing keyless exists. tesseract,
 * ollama and llama-cli are all absent locally, Groq answers 401, Gemini 403,
 * and Cloudflare needs an account id. OpenRouter answered 200 and lists 14
 * FREE models that accept image input, including google/gemma-4-31b-it:free at
 * 262k context. One free key, and the source degrades to empty without it.
 */

import type { Env } from '@quorum/sources';

/*
 * Free vision models, in preference order, MEASURED LIVE 2026-08-22.
 *
 * A single pinned model was the first design, on the reasoning that a silently
 * swapped model is a silently changed answer. That reasoning is right and the
 * design was still wrong, because a free tier is a SHARED POOL and pinning one
 * model means inheriting everyone else's rate limit. The first live call
 * returned 429: "google/gemma-4-31b-it:free is temporarily rate-limited
 * upstream", which is not our key, our quota or our fault.
 *
 * Tested all eight free models that accept image input, on the same key,
 * minutes apart:
 *
 *   nvidia/nemotron-nano-12b-v2-vl:free   200, answered
 *   dots-studio/dots-3-note-preview:free  200, unexpected response shape
 *   nvidia/nemotron-3.5-content-safety    200, unexpected response shape
 *   nvidia/nemotron-3-nano-omni-30b       502, upstream resource exhausted
 *   google/gemma-4-26b-a4b-it:free        429, shared pool limited
 *   google/gemma-4-31b-it:free            429, shared pool limited
 *   thinkingmachines/inkling:free         403, not available on this tier
 *   thinkingmachines/inkling-small:free   403, not available on this tier
 *
 * So the list is ordered and tried in turn, and the model that ACTUALLY
 * answered is recorded on the reading. Reproducibility is preserved where it
 * matters: you can always see which model produced a given sentence. What is
 * given up is the guarantee that two runs use the same one, and on a free
 * shared pool that guarantee was never real.
 */
export const VISION_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'dots-studio/dots-3-note-preview:free',
] as const;

export const DEFAULT_VISION_MODEL = VISION_MODELS[0];

/* Worth trying the next model for. A 400 is our mistake and retrying it just
 * burns the list. */
const WORTH_FAILING_OVER = new Set([402, 403, 408, 429, 500, 502, 503, 504]);
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export type ReadingKind = 'transcription' | 'description';

export interface ImageReading {
  /*
   * THE RECEIPT. The image this was read from, so a reader can look at the
   * same thing the model looked at. Without this the reading is unfalsifiable.
   */
  imageUrl: string;
  kind: ReadingKind;
  text: string;
  /* Which model said it, because a claim with no author is not checkable. */
  model: string;
  /* Unix seconds. A model's reading of an image can change between versions. */
  readAt: number;
  /*
   * ALWAYS TRUE, AND IT IS NOT DECORATION.
   *
   * It exists so that any code holding one of these has to acknowledge what it
   * is holding. A field that is always true is a strange thing to write on
   * purpose; the point is that `if (thing.derived)` reads correctly at a call
   * site and cannot be forgotten the way a comment can.
   */
  derived: true;
}

export interface VisionResult {
  ok: boolean;
  reading?: ImageReading;
  /* Present when the read failed. Safe to show a caller. */
  error?: string;
}

/*
 * A MODEL THAT SAYS "NOTHING" HAS NOT TRANSCRIBED THE WORD "NOTHING".
 *
 * The transcription prompt ends "if there is no text, reply with nothing", and
 * measured live 2026-08-22 on a product photograph with no text in it, the
 * model replied with exactly that: `Nothing`. Taken literally it became a seven
 * character reading, printed under the image as though it were content.
 *
 * That is worse than useless, because this block is the one place in a report
 * where a generated sentence sits near real evidence, and filling it with noise
 * is how a reader stops reading the label above it.
 *
 * Only an exact match after normalising counts. A real transcription that
 * happens to be the single word "none" is possible and would be lost, and that
 * trade is worth making in this direction.
 */
const EMPTY_ANSWERS = new Set(['nothing', 'none', 'no text', 'n/a', 'empty', 'no text present', 'there is no text']);

function isEmptyAnswer(text: string): boolean {
  return EMPTY_ANSWERS.has(text.toLowerCase().replace(/[.!]+$/, '').trim());
}

/* The two prompts, kept here rather than at call sites so the wording that
 * produced a reading is the wording in version control. */
const PROMPTS: Record<ReadingKind, string> = {
  transcription:
    'Transcribe every word of text that appears in this image, exactly as written. '
    + 'Include headlines, captions, prices, button labels and small print. '
    + 'Do not describe the image. Do not explain. If there is no text, reply with nothing.',
  description:
    'Describe what is shown in this image in two sentences. '
    + 'State only what is visibly present. Do not guess at brands, prices or intent.',
};

export interface VisionOptions {
  /* One model, or the ordered fallback list when absent. */
  model?: string;
  kind?: ReadingKind;
  timeoutMs?: number;
  /* Injected. Unix seconds. */
  now?: () => number;
  /*
   * Fetches the image bytes. Must be the SSRF guarded client, because image
   * urls come from user supplied pages.
   */
  fetchImage: (url: string) => Promise<{ ok: boolean; body: string; headers: Record<string, string>; error?: string }>;
  /* Posts to the model. Injected so this is testable with no network. */
  post: (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number })
    => Promise<{ ok: boolean; status: number; body: string; error?: string }>;
}

export function visionConfigured(env: Env): boolean {
  return Boolean(env['OPENROUTER_API_KEY']);
}

/*
 * Read one image. Never throws: a vision provider being down degrades a run,
 * and a report without image readings is still a good report.
 */
export async function readImage(
  imageUrl: string,
  env: Env,
  options: VisionOptions,
): Promise<VisionResult> {
  /* Trimmed for the reason given in claims.ts: a pasted key carries a newline. */
  const key = env['OPENROUTER_API_KEY']?.trim();
  if (!key) return { ok: false, error: 'vision not configured' };

  const kind = options.kind ?? 'transcription';
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const image = await options.fetchImage(imageUrl);
  if (!image.ok || !image.body) {
    return { ok: false, error: image.error ?? 'image could not be fetched' };
  }

  /*
   * The mime type comes from the response rather than from the url, because a
   * cdn serves webp from a path ending .jpg constantly and a wrong mime is a
   * silent rejection at the far end.
   */
  const contentType = image.headers['content-type']?.split(';')[0]?.trim();
  if (!contentType || !contentType.startsWith('image/')) {
    return { ok: false, error: `not an image: ${contentType ?? 'no content type'}` };
  }

  /*
   * Try each model until one answers. Every attempt is recorded so a failure
   * explains itself rather than reporting only whichever model happened to be
   * last in the list.
   */
  const models = options.model ? [options.model] : [...VISION_MODELS];
  const attempts: string[] = [];
  let text = '';
  let answeredBy = '';

  for (const candidate of models) {
    const response = await options.post(ENDPOINT, {
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      timeoutMs: options.timeoutMs ?? 60_000,
      body: JSON.stringify({
        model: candidate,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPTS[kind] },
            { type: 'image_url', image_url: { url: `data:${contentType};base64,${image.body}` } },
          ],
        }],
      }),
    });

    if (!response.ok) {
      attempts.push(`${candidate}: ${response.error ?? `status ${response.status}`}`);
      if (WORTH_FAILING_OVER.has(response.status)) continue;
      return { ok: false, error: attempts.join('; ') };
    }

    let parsed: {
      choices?: { message?: { content?: unknown } }[];
      error?: { code?: unknown; message?: unknown };
    };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      attempts.push(`${candidate}: response was not json`);
      continue;
    }

    /*
     * A 200 carrying an error object is normal here: the gateway accepted the
     * request and the upstream provider refused it. Treating that as success
     * would store an empty reading as though a model had answered.
     */
    if (parsed.error) {
      attempts.push(`${candidate}: ${String(parsed.error.message ?? 'provider error')}`);
      continue;
    }

    const content = parsed.choices?.[0]?.message?.content;
    const candidateText = typeof content === 'string' ? content.trim() : '';
    if (!candidateText || isEmptyAnswer(candidateText)) {
      attempts.push(`${candidate}: returned nothing`);
      continue;
    }

    text = candidateText;
    answeredBy = candidate;
    break;
  }

  if (!answeredBy) {
    return { ok: false, error: attempts.join('; ') || 'no vision model answered' };
  }

  return {
    ok: true,
    reading: { imageUrl, kind, text, model: answeredBy, readAt: now(), derived: true },
  };
}
