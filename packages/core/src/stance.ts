/*
 * Whether a record's mention of a term is evidence FOR that term.
 *
 * THE DEFECT, SEEN LIVE 2026-08-23. A "running shoes" report printed, as a
 * receipt under the finding "problems", a glowing review: "I really liked the
 * shoes. The foam was great, and I had absolutely no problem picking up the
 * pace." The word matched, the stance was the opposite, and the corroboration
 * count presented praise as a complaint.
 *
 * SCOPED TO COMPLAINT SHAPED TERMS, DELIBERATELY. Negation only flips
 * evidencehood for terms where "no X" means the absence of X: "no problems"
 * is not problem evidence, but "not worth the price" is exactly price
 * evidence, and "not durable" is durability evidence. A generic negation
 * filter would throw away the second and third kind, which is a worse error
 * than the one being fixed. So the filter names the terms it applies to and
 * touches nothing else.
 *
 * A record is dropped only when EVERY mention is negated. One comment saying
 * "no problems with the sole, but a real problem at the heel" is problem
 * evidence and stays.
 */

import type { Doc } from '@quorum/corpus';

/*
 * Terms where negation means absence. First word, stemmed of a trailing s,
 * so "problems", "problem" and "battery issues" all resolve here by their
 * complaint word.
 */
const ABSENCE_TERMS = new Set([
  'problem', 'issue', 'defect', 'complaint', 'fault', 'flaw', 'bug',
  'drawback', 'downside', 'regret',
]);

/* Words that negate what follows within a short window. */
const NEGATORS = new Set([
  'no', 'not', 'never', 'zero', 'without', 'hardly', 'barely',
  'isnt', "isn't", 'arent', "aren't", 'wasnt', "wasn't", 'werent', "weren't",
  'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't",
  'cant', "can't", 'couldnt', "couldn't", 'wont', "won't", 'wouldnt', "wouldn't",
  'havent', "haven't", 'hasnt', "hasn't", 'hadnt', "hadn't",
]);

/*
 * How far back a negator reaches, in words. "had absolutely no problem" needs
 * the window to cross one intensifier; "no real problem" one adjective. Three
 * covers both without letting a "no" at the start of a long sentence negate a
 * complaint at its end.
 */
const NEGATION_WINDOW = 3;

const complaintStem = (term: string): string | null => {
  const first = term.toLowerCase().split(/\s+/)[0] ?? '';
  const stem = first.replace(/s$/, '');
  return ABSENCE_TERMS.has(stem) ? stem : null;
};

export function mentionsAllNegated(term: string, text: string): boolean {
  const stem = complaintStem(term);
  if (!stem) return false;

  const tokens = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  let mentions = 0;
  let negated = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]!.startsWith(stem)) continue;
    mentions++;
    const from = Math.max(0, i - NEGATION_WINDOW);
    if (tokens.slice(from, i).some((w) => NEGATORS.has(w))) negated++;
  }
  return mentions > 0 && mentions === negated;
}

/*
 * The rows that count as evidence for a term. Applied BEFORE corroboration and
 * before the quote sample, so the count and the quotes cannot disagree about
 * what the evidence says.
 */
export function evidenceRowsFor(term: string, rows: readonly Doc[]): Doc[] {
  if (!complaintStem(term)) return [...rows];
  return rows.filter((row) => !mentionsAllNegated(term, row.text));
}
