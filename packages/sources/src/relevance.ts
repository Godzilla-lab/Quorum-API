/*
 * Record level relevance, shared by every source that does free text search.
 *
 * WHY THIS EXISTS, measured 2026-08-22 on a real end to end run.
 *
 * The Reddit path has a gate on which COMMUNITIES it will harvest from, and it
 * works. Hacker News had no gate at all, so a "running shoes" report searched
 * for the bare term "sizing", which on Hacker News means CSS sizing and font
 * sizing, and poured 95 unrelated developer threads into the corpus. The
 * corroboration line then reported "217 records across 97 channels" when 95 of
 * those channels were threads about Internet Explorer, RISC versus CISC, and
 * grid stylesheets.
 *
 * That is the worst possible failure for this product. It is not a bad report,
 * it is a fabricated corroboration count presented as evidence, in front of a
 * customer, with real receipts underneath it that lead to real people talking
 * about something else entirely.
 *
 * So: a gate on communities is not enough. Anything a free text search returns
 * has to be checked against the subject before it is stored, because every run
 * writes to the corpus and the corpus is what later runs trust.
 *
 * Deliberately lexical, not semantic. It is free, it is deterministic, and the
 * failure it catches is itself lexical.
 */

/*
 * Words shorter than this never become terms. That floor is what makes prefix
 * matching safe: "men" is never a term, so it can never match "mental".
 */
const MIN_TERM_LENGTH = 4;

/*
 * Terms describing WHAT IS BEING RESEARCHED. The category and the product, and
 * nothing else.
 *
 * NEVER pass the query terms in here. Gating on the words you just searched for
 * is circular and passes everything by construction: a search for "sizing"
 * returns "RISC vs CISC and instruction sizing tradeoffs", which then clears a
 * gate that counts "sizing" as evidence of being about shoes. Found by a test
 * on 2026-08-22.
 *
 * Search on the questions. Gate on the subject.
 */
export function subjectTerms(phrases: string[]): string[] {
  return [...new Set(
    phrases
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= MIN_TERM_LENGTH),
  )];
}

export interface RelevanceHit {
  hits: number;
  matched: string[];
  /* Reported for inspection. Never gated on. See below. */
  ratio: number;
}

/*
 * Count how many subject terms appear in a piece of text.
 *
 * Whole word ish: a word boundary followed by the term as a prefix, so "shoe"
 * matches "shoes" and "shoemaker" but a term cannot match inside an unrelated
 * word.
 *
 * The gate counts and never divides. A ratio inverts the gate's purpose,
 * because the better a planner gets at generating terms the more terms there
 * are, and the harder it becomes for any single record to clear a fraction.
 * Measured on the engine: a ratio gate dropped r/Fitness and r/bodybuilding,
 * the two best communities available.
 */
export function scoreText(text: string, terms: string[]): RelevanceHit {
  if (!terms.length) return { hits: 0, matched: [], ratio: 0 };
  const haystack = text.toLowerCase();
  /*
   * Stem tolerant on the trailing plural, because "shoe" and "shoes" are the
   * same word and prefix matching only handles one direction. `\bshoes` never
   * matched "Barefoot Running Shoe", so a thread title that plainly names the
   * subject scored one instead of two. The same bug was fixed once in the
   * subreddit scorer and left here, which is how a rule ends up meaning two
   * different things in one codebase.
   */
  const matched = terms.filter((t) => {
    const stem = t.replace(/s$/, '');
    if (new RegExp(`\\b${t}`, 'i').test(haystack)) return true;
    return stem !== t && stem.length >= MIN_TERM_LENGTH && new RegExp(`\\b${stem}`, 'i').test(haystack);
  });
  return { hits: matched.length, matched, ratio: matched.length / terms.length };
}

/*
 * Score a squashed identifier, where word boundaries do not exist.
 *
 * A subreddit name has no spaces, so the word boundary prefix rule that works
 * on prose only ever matches at position zero: "runningshoegeeks" matched
 * "running" and never "shoes", so the community most obviously about the
 * subject scored the same as one about nothing. Substring matching is the right
 * instrument for a handle, and the trailing plural is stripped for the same
 * reason it is in phrase matching, so "shoes" finds "shoegeeks".
 *
 * Substring matching is looser than prefix matching, and that is fine HERE
 * because a handle has to carry the whole subject to count for anything. See
 * isRelevantRecord.
 */
export function scoreHandle(handle: string, terms: string[]): RelevanceHit {
  if (!terms.length) return { hits: 0, matched: [], ratio: 0 };
  const haystack = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matched = terms.filter((t) => {
    const stem = t.replace(/s$/, '');
    return haystack.includes(t) || (stem.length >= MIN_TERM_LENGTH && haystack.includes(stem));
  });
  return { hits: matched.length, matched, ratio: matched.length / terms.length };
}

/*
 * Does the text contain the subject as an actual PHRASE.
 *
 * MEASURED 2026-08-22 on 207 real Hacker News records stored for a "running
 * shoes" report:
 *
 *   counting terms, need 1     207 kept (100%)  useless
 *   counting terms, need 2     185 kept  (89%)  still lets through Aldi, Etsy,
 *                                               housing economics and Mac Pro
 *                                               threads, because a long comment
 *                                               mentions "running" and "shoes"
 *                                               separately in unrelated places
 *   requiring the phrase       111 kept  (54%)  and the survivors are real:
 *                                               "Brooks Gravitas running shoes,
 *                                               more comfortable for my wide
 *                                               feet than my Hokas"
 *
 * Term counting cannot fix this, because the failure is not about how many
 * subject words appear, it is about whether they appear TOGETHER. On a general
 * forum a single incidental mention is not evidence about the product.
 *
 * Tolerates a trailing plural on the final word, so "running shoe" matches
 * "running shoes" and the reverse.
 */
export function matchesSubjectPhrase(text: string, phrases: string[]): boolean {
  for (const phrase of phrases) {
    const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;

    const head = words.slice(0, -1);
    /*
     * Optional trailing s on the final word only, and the stem is taken FIRST.
     * Appending s? to a word that is already plural produces "shoess?", which
     * matches "shoes" but not "shoe", so "running shoes" stopped matching
     * "running shoe". Caught by a test on 2026-08-22.
     */
    const last = words[words.length - 1]!.replace(/s$/, '');
    const pattern = [...head, `${last}s?`].join('\\s+');

    if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) return true;
  }
  return false;
}

/*
 * How many times the subject appears as a phrase, rather than merely whether it
 * does. Used to tell a person discussing the product from a person mentioning
 * it once while arguing about something else.
 */
export function countSubjectPhrase(text: string, phrases: string[]): number {
  let total = 0;
  for (const phrase of phrases) {
    const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    const head = words.slice(0, -1);
    const last = words[words.length - 1]!.replace(/s$/, '');
    const pattern = [...head, `${last}s?`].join('\\s+');
    total += (text.match(new RegExp(`\\b${pattern}\\b`, 'gi')) ?? []).length;
  }
  return total;
}

/*
 * MEASURED 2026-08-22 on 150 real Hacker News records stored for a "running
 * shoes" report. 131 of them, 87%, sat in threads about something else:
 * "Wooden bikes", "3 years of bra engineering", "Why are we so bad at software
 * engineering?", "The FDA will likely approve the diabetes drug tirzepatide".
 *
 * Each one genuinely contained the phrase "running shoes", so the phrase gate
 * passed every one, and the report then stated "82 receipts across 72 channels"
 * for a claim about problems with running shoes. That number reads as a market
 * consensus. It was 77 people mentioning shoes once while talking about
 * something else.
 *
 * WHAT DECIDES IT IS FOCUS, NOT REPETITION. Counting mentions was the first
 * attempt and it was wrong: it rejected "Brooks Gravitas running shoes. More
 * comfortable for my wide feet than my Hokas", which is the exact voice of
 * customer this product exists to find, because it names the subject only once.
 *
 * A short comment that names the product is about the product. A thousand word
 * essay that mentions it once, in a thread about wooden bikes, is not. So the
 * subject has to come up at least once per this many characters, which is
 * roughly once a paragraph.
 *
 * Measured on those 150 records, where the thread was off topic:
 *
 *   one per 200 chars   keeps 16%
 *   one per 400 chars   keeps 22%
 *   one per 600 chars   keeps 40%, and admits a 560 character comment about
 *                       bra engineering that mentions shoes once
 *
 * 400 is the middle. Stated honestly, it costs us a real one: a 553 character
 * comment saying "high quality running shoes seem to max out at ~150" is
 * genuine price evidence and needs two mentions at this setting, so it is lost.
 * That is the price of rejecting the thousand word asides, and it is worth
 * paying because a false receipt is far more expensive than a missing one.
 */
const CHARS_PER_SUBJECT_MENTION = 400;

export interface RecordGateOptions {
  /*
   * How many subject terms a record must mention. One is the right default in
   * `terms` mode: a comment saying "the sizing on these runs small" inside a
   * running community mentions the subject once and is exactly what we want.
   */
  minHits?: number;

  /*
   * `terms`  counts subject words anywhere in the record. Right for a source
   *          that is ALREADY scoped, like a subreddit, where the community has
   *          done most of the filtering.
   * `phrase` requires the subject as an adjacent phrase. Right for a general
   *          forum, where a term means whatever that audience means by it.
   */
  mode?: 'terms' | 'phrase';

  /* The subject as written, for phrase mode. Ignored in terms mode. */
  phrases?: string[];

  /*
   * What kind of thing `channel` is.
   *
   *   title   natural language, like a Hacker News story headline
   *   handle  a squashed identifier, like a subreddit name
   *
   * Defaults to `title`, which is the permissive reading. A source whose
   * channel is an identifier must say so, because a handle that only prefix
   * matches one subject word is how r/woolworths cleared the gate for a "wool
   * runner" report. See isRelevantRecord.
   */
  channelKind?: 'title' | 'handle';
}

/*
 * Is this record about the thing we are researching.
 *
 * Checks the record text and the place it came from together, because a comment
 * inside a clearly on topic thread is on topic even when the sentence itself is
 * elliptical. "Same, had to size up" says nothing on its own and everything in
 * a thread titled "these shoes run small".
 */
export function isRelevantRecord(
  text: string,
  channel: string,
  terms: string[],
  { minHits = 1, mode = 'terms', phrases = [], channelKind = 'title' }: RecordGateOptions = {},
): boolean {
  /*
   * THE CHANNEL SUPPLIES SOME OF THE SUBJECT. THE RECORD SUPPLIES THE REST.
   *
   * Two live failures on 2026-08-22 pushed this through three wrong shapes
   * before it settled, and both are worth keeping because they bound the
   * answer from opposite sides.
   *
   *   TOO LOOSE. Scoring `text + channel` as one blob let a community vouch for
   *   itself by prefix: "wool" matches "woolworths", so all 73 records from an
   *   Australian supermarket cleared a "wool runner" gate and the report stated
   *   findings from comments about facemasks.
   *
   *   TOO TIGHT. Requiring the full subject in the TEXT whenever the channel
   *   did not carry all of it dropped reddit from 362 records to THREE on
   *   "running shoes", because a comment in r/running says "these shoes run
   *   small" and never repeats the word running. That destroys the main case to
   *   fix the niche one.
   *
   * What actually separates the good case from the bad one is how much of the
   * subject the CONTAINER genuinely accounts for:
   *
   *   r/runningshoegeeks   carries running and shoe    supplies 2 of 2
   *   r/running            carries running             supplies 1 of 2
   *   r/runninglifestyle   carries neither wool nor runner   supplies 0 of 2
   *
   * So the requirement is the whole subject, and the channel is credited with
   * the part it really carries. "Same, had to size up" survives in a dedicated
   * shoe community, "these shoes run small" survives in r/running, and a Brooks
   * Glycerin review no longer survives in a wool runner report.
   *
   * Capped at two, because a three word subject demanding all three would
   * reject nearly everything a person actually writes.
   */
  const channelHits = channelKind === 'handle'
    ? scoreHandle(channel, terms).hits
    : scoreText(channel, terms).hits;

  /*
   * Strict mode, for general forums where a question term means whatever it
   * means to that audience. Requires the subject as a phrase, not as scattered
   * words. See matchesSubjectPhrase for the measurement behind this.
   */
  if (mode === 'phrase' && phrases.length) {
    /* A handle is a squashed identifier and cannot carry prose, so the record
     * has to supply the phrase itself. */
    if (channelKind !== 'title') return matchesSubjectPhrase(text, phrases);

    /*
     * ON A GENERAL FORUM, THE THREAD TOPIC IS WHAT MAKES A COMMENT TOPICAL.
     *
     * This is the opposite conclusion from the handle case, and both are right.
     * A subreddit name is an identifier that prefix matches by accident, so it
     * cannot be trusted to vouch for its own records. A story title is prose
     * written to describe what the conversation is about, so it can.
     *
     * A person answering "what running shoes should I buy" is giving market
     * evidence. The same person mentioning running shoes once inside an
     * argument about drug pricing is making an analogy. Counting the second as
     * a receipt is how a corroboration count stops meaning anything, and it is
     * what this repo shipped until the numbers were read next to their quotes.
     *
     * The useful side effect: Hacker News now carries weight exactly where it
     * should. For a developer product its threads are about the subject and
     * almost everything survives. For a consumer product they are not, and it
     * stops flooding the report with asides.
     */
    /*
     * The thread is about the subject, so the conversation inside it is too and
     * the record does not have to repeat the topic. This is the same rule a
     * subreddit gets, for the same reason: the container established what is
     * being discussed. "Same, had to size up half a size" is a real answer under
     * "Best running shoes for wide feet?" and carries no subject word at all.
     */
    if (scoreText(channel, terms).hits > 0 || matchesSubjectPhrase(channel, phrases)) return true;

    /* The thread is about something else, so the record has to be about the
     * subject on its own. See the note above on focus rather than repetition. */
    const needed = Math.max(1, Math.ceil(text.length / CHARS_PER_SUBJECT_MENTION));
    return countSubjectPhrase(text, phrases) >= needed;
  }

  if (!terms.length) return true;

  const required = Math.max(minHits, Math.min(terms.length, 2));
  return scoreText(text, terms).hits + channelHits >= required;
}
