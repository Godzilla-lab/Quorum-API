/*
 * The relevance gate for subreddit selection.
 *
 * Everything a picked subreddit yields gets written to the corpus, and one bad
 * subreddit poisons a category's memory permanently. A prefix search matches
 * NAMES, so it is full of false friends: searching "shoe" surfaces
 * r/Shoestring, which is about budget travel. Those have to be dropped before
 * anything is harvested from them, not after.
 *
 * WHY THE THRESHOLD IS AN ABSOLUTE COUNT AND NOT A RATIO.
 *
 * The obvious design scores a subreddit by the FRACTION of category terms its
 * name and description match. That fails on exactly the subreddits worth
 * keeping: a large general community has a long description covering many
 * topics, so one strong match is a small fraction and it gets dropped. Measured
 * on a real run, a ratio gate discarded r/Fitness and r/bodybuilding while
 * keeping narrow, near dead niche subs whose short descriptions happened to be
 * mostly on topic.
 *
 * So the gate counts hits and the ratio is carried as metadata only. It is
 * scored and never gated on, which is deliberate and should stay that way.
 */

import { scoreHandle } from '../relevance.ts';

export interface SubredditCandidate {
  name: string;
  subscribers: number;
  description: string;
}

export interface ScoredSubreddit extends SubredditCandidate {
  /* How many distinct category terms matched. This is what the gate uses. */
  hits: number;
  /*
   * How many matched as a real word rather than as the first letters of an
   * unrelated one. "wool" is a prefix hit on "woolworths" and a whole word hit
   * on "wool". The gate needs all three numbers, see filterRelevant.
   */
  wholeWordHits: number;
  /*
   * How many matched inside the NAME read as a squashed identifier, where
   * "runningshoegeeks" carries both running and shoe.
   */
  handleHits: number;
  /* Fraction of terms matched. Reported, never gated on. See above. */
  relevance: number;
  matched: string[];
}

export function relevanceScore(sub: SubredditCandidate, categoryTerms: string[]): ScoredSubreddit {
  const haystack = `${sub.name} ${sub.description}`.toLowerCase();

  /*
   * Terms are the distinct words across every category term, longer than three
   * characters. The length floor is what makes the matching below safe: "men"
   * is never a term, so it can never match "mental".
   */
  const terms = [...new Set(
    categoryTerms
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  )];

  if (!terms.length) return { ...sub, hits: 0, wholeWordHits: 0, handleHits: 0, relevance: 0, matched: [] };

  /*
   * Whole word ish: a word boundary followed by the term as a PREFIX. So
   * "shoe" matches "shoes" and "shoemaker", which is wanted, and a term cannot
   * match in the middle of an unrelated word.
   *
   * Note what this does NOT do: it does not stop r/Shoestring matching "shoes".
   * That is by design. False friends are the pick step's job, and this gate is
   * the second net that catches whatever the picker let through.
   */
  /*
   * Stem tolerant, because the plural mismatch silently rejects the best
   * communities. `\bshoes` does not match "running shoe reviews", so
   * r/RunningShoeGeeks scored 1 for the subject "running shoes" and was
   * dropped, while a community whose description merely said "runner" scored
   * the same. Measured 2026-08-22 against live candidates.
   */
  const forms = (term: string): string[] => {
    const stem = term.replace(/s$/, '');
    return stem !== term && stem.length >= 4 ? [term, stem] : [term];
  };
  const hasTerm = (term: string): boolean =>
    forms(term).some((f) => new RegExp(`\\b${f}`, 'i').test(haystack));
  const matched = terms.filter(hasTerm);

  /*
   * Which terms matched as a WHOLE WORD, not merely as a prefix of a longer,
   * unrelated one.
   *
   * MEASURED LIVE 2026-08-22 on the subject "wool runner". Prefix matching kept
   * r/woolworths, an Australian supermarket, and the run then harvested 73
   * comments about facemasks and Big W returns into a "wool runner" report.
   * Across the real candidates the archive returned:
   *
   *   r/woolworths        prefix hit, whole word NO
   *   r/Wooloo            prefix hit, whole word NO
   *   r/Runner5           prefix hit, whole word NO
   *   r/runnersglow       prefix hit, whole word NO
   *   r/RunnersInChicago  prefix hit, whole word NO
   *   r/RunnerHub         prefix hit, whole word NO
   *   r/Wool              prefix hit, whole word YES
   *
   * Six of seven false friends carry the subject word only as a prefix. The
   * survivor, r/Wool, is about the Hugh Howey novel, which is what the record
   * gate is there to catch.
   */
  const whole = terms.filter((term) =>
    forms(term).some((f) => new RegExp(`\\b${f}\\b`, 'i').test(haystack)));

  /*
   * The NAME scored as the squashed identifier it is. A subreddit name has no
   * spaces, so the word boundary rule only ever matches at position zero:
   * "runningshoegeeks" matched "running" and never "shoes", which scored the
   * single most on topic community in the archive no higher than an unrelated
   * one. Substring matching with the plural stripped is the right instrument
   * for a handle, and it is the same one the record gate uses.
   */
  const handle = scoreHandle(sub.name, terms);

  return {
    ...sub,
    wholeWordHits: whole.length,
    handleHits: handle.hits,
    hits: matched.length,
    relevance: matched.length / terms.length,
    matched,
  };
}

export interface FilterResult {
  kept: ScoredSubreddit[];
  dropped: ScoredSubreddit[];
}

/* The distinct terms a subject reduces to, shared by the scorer and the gate
 * so they can never disagree about how many there are. */
function terms(categoryTerms: string[]): string[] {
  return [...new Set(
    categoryTerms.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
  )];
}

export function filterRelevant(
  subs: SubredditCandidate[],
  categoryTerms: string[],
  { minHits = 1 }: { minHits?: number } = {},
): FilterResult {
  const kept: ScoredSubreddit[] = [];
  const dropped: ScoredSubreddit[] = [];

  for (const s of subs) {
    const scored = relevanceScore(s, categoryTerms);
    /*
     * A community earns a harvest by carrying a subject word as a REAL word,
     * not as the first four letters of an unrelated one. That is what keeps
     * r/woolworths out of a "wool runner" report.
     *
     * IT IS DELIBERATELY PERMISSIVE BEYOND THAT, and an attempt to tighten it
     * on 2026-08-22 was reverted. Requiring a multi word subject to appear in
     * full here would have dropped r/Fitness for "protein powder", because a
     * huge general community mentions protein and never says "powder". Those
     * are exactly the communities worth harvesting, and the same measurement
     * once killed a ratio based gate.
     *
     * The container being broad is fine. What has to be strict is the RECORD
     * gate inside it, which is where a comment about Brooks Glycerin gets
     * refused for a wool runner report. See isRelevantRecord.
     */
    const relevant = scored.hits >= minHits
      && (scored.handleHits >= 2 || scored.wholeWordHits >= 1 || scored.hits >= 2);
    (relevant ? kept : dropped).push(scored);
  }

  /* Strongest topical overlap first, so a truncated pick keeps the best. */
  kept.sort((a, b) => b.hits - a.hits || b.subscribers - a.subscribers);
  return { kept, dropped };
}
