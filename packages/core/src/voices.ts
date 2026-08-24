/*
 * How many distinct voices a pile of receipts actually is.
 *
 * The receipt count dedupes by receipt id, which stops one row counted twice,
 * and can do nothing about one TEXT stored twice under two ids: copypasta,
 * crossposts, bot swarms posting the same paragraph with the spelling
 * shuffled. Twenty five near identical comments are one voice wearing twenty
 * five hats, and a corroboration line that counts hats is the exact number
 * this product exists not to fabricate.
 *
 * ADDITIVE, LIKE EVERY CHANGE TO CORROBORATION BEFORE IT. The promotion
 * routes in corroborate.ts are untouched: the header there says the absolute
 * count stays until report parity against the engine is measurable, and it
 * has not been measured yet. This module REPORTS the collapsed number next to
 * the raw one, so a reader can see the difference; gating on it is a decision
 * for after parity and a labelled dedup eval set exist.
 *
 * MINHASH OVER 3 WORD SHINGLES, PURE JS, NO DEPENDENCIES. MinHash rather than
 * SimHash because short social text at high similarity thresholds is exactly
 * where MinHash's Jaccard estimate behaves better. 64 lanes bounds the
 * estimate's error near +-0.06 at the 0.8 threshold, and 500 records per term
 * (EVIDENCE_PER_TERM) keeps the pairwise pass at ~125k signature
 * comparisons, well under a millisecond of integer equality. What this
 * catches is light edits of the same text. TRUE PARAPHRASE, the same claim
 * in different words, needs a model and is deliberately out of scope here.
 */

import type { Doc } from '@quorum/corpus';

const LANES = 64;
const SHINGLE_WORDS = 3;
/*
 * Estimated Jaccard at or above which two texts are the same voice. High on
 * purpose: collapsing two genuinely different comments into one voice throws
 * away real corroboration, which is a worse error than letting a paraphrase
 * through. Copypasta sits near 1.0; independent comments about the same
 * product rarely clear 0.5.
 */
const SAME_VOICE = 0.8;

/* FNV-1a, seeded per lane by mixing the lane index into the offset basis. */
const fnv1a = (text: string, seed: number): number => {
  let hash = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const normalise = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function textSignature(text: string): Uint32Array {
  const words = normalise(text);
  const shingles: string[] = [];
  if (words.length < SHINGLE_WORDS) {
    /* A very short text is its own shingle; it can still be copypasta. */
    if (words.length) shingles.push(words.join(' '));
  } else {
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
      shingles.push(words.slice(i, i + SHINGLE_WORDS).join(' '));
    }
  }

  const signature = new Uint32Array(LANES).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let lane = 0; lane < LANES; lane++) {
      const h = fnv1a(shingle, lane);
      if (h < signature[lane]!) signature[lane] = h;
    }
  }
  return signature;
}

export function estimatedJaccard(a: Uint32Array, b: Uint32Array): number {
  let equal = 0;
  for (let lane = 0; lane < LANES; lane++) if (a[lane] === b[lane]) equal++;
  return equal / LANES;
}

export interface VoiceCount {
  /* Distinct near duplicate clusters: the honest lower bound on people. */
  independent: number;
  /* Receipts that turned out to be a copy of another receipt's text. */
  collapsed: number;
}

export function countVoices(records: readonly Doc[]): VoiceCount {
  /* One receipt is one candidate voice, however many category rows it has. */
  const unique: Doc[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.receiptId)) continue;
    seen.add(record.receiptId);
    unique.push(record);
  }
  if (unique.length <= 1) return { independent: unique.length, collapsed: 0 };

  const signatures = unique.map((r) => textSignature(r.text));

  /* Union find, path halving. */
  const parent = unique.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (find(i) === find(j)) continue;
      if (estimatedJaccard(signatures[i]!, signatures[j]!) >= SAME_VOICE) {
        parent[find(j)] = find(i);
      }
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < unique.length; i++) roots.add(find(i));
  return { independent: roots.size, collapsed: unique.length - roots.size };
}
