/*
 * Production wiring for vision.
 *
 * `readImage` takes its transport as arguments so it can be tested with no
 * network at all. This file is the one place that supplies the real ones, and
 * both of them go through the SSRF guard.
 *
 * THE IMAGE FETCH IS GUARDED, AND THAT IS NOT OPTIONAL HERE.
 *
 * Image urls come out of user supplied product pages and out of scraped ad
 * payloads, which is exactly the untrusted input `safeFetch` exists for.
 * Reading them ourselves rather than handing the url to a vendor also means an
 * internal address is never fetched on our behalf by someone outside our
 * network boundary.
 */

import { safeFetch } from '@quorum/sources';
import type { Env } from '@quorum/sources';
import { readImage, type VisionOptions, type VisionResult } from './vision.ts';
import { expandSubject, type ExpansionResult } from './expand.ts';
import { askClaims } from './claims.ts';
import type { AskModel } from '@quorum/core';

/*
 * Product photographs run to a few hundred kilobytes and ad creative larger.
 * Two megabytes covers both with room to spare, and refuses anything that is
 * really a video or a mistake.
 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;

export interface ReaderOptions {
  model?: string;
  kind?: VisionOptions['kind'];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function readImageLive(
  imageUrl: string,
  env: Env,
  options: ReaderOptions = {},
): Promise<VisionResult> {
  return readImage(imageUrl, env, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),

    fetchImage: async (url) => {
      const result = await safeFetch(url, {
        binary: true,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: IMAGE_TIMEOUT_MS,
        headers: { accept: 'image/*' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        ok: result.ok,
        body: result.body,
        headers: result.headers,
        ...(result.error ? { error: result.error } : {}),
      };
    },

    post: async (url, init) => {
      const result = await safeFetch(url, {
        method: 'POST',
        body: init.body,
        headers: init.headers,
        timeoutMs: init.timeoutMs,
        /* A long transcription of a dense ad can run to tens of kilobytes. */
        maxBytes: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        ok: result.ok,
        status: result.status,
        body: result.body,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}


/* The same guarded transport, for the text call that expands a subject. */
export async function expandSubjectLive(
  subject: string,
  env: Env,
  options: { model?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExpansionResult> {
  return expandSubject(subject, env, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    post: async (url, init) => {
      const result = await safeFetch(url, {
        method: 'POST',
        body: init.body,
        headers: init.headers,
        timeoutMs: init.timeoutMs,
        maxBytes: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        ok: result.ok,
        status: result.status,
        body: result.body,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}


/*
 * The same guarded transport, for synthesis.
 *
 * The body cap is larger than expansion's because a synthesis answer is a list
 * of claims over a whole evidence book rather than three brand names, and it is
 * still a cap: a model that loops forever should hit a limit rather than a
 * timeout, because a limit says what happened.
 */
const MAX_CLAIMS_BYTES = 4 * 1024 * 1024;

export function askClaimsLive(
  env: Env,
  options: { model?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): AskModel {
  return askClaims(env, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    post: async (url, init) => {
      const result = await safeFetch(url, {
        method: 'POST',
        body: init.body,
        headers: init.headers,
        timeoutMs: init.timeoutMs,
        maxBytes: MAX_CLAIMS_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        ok: result.ok,
        status: result.status,
        body: result.body,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}
