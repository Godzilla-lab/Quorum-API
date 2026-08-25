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
 * Words this long and over match as PREFIXES. The floor is what makes prefix
 * matching safe: "men" is never a prefix term, so it can never match "mental".
 */
const MIN_TERM_LENGTH = 4;

/*
 * Words of exactly this length become EXACT MATCH terms rather than being
 * dropped.
 *
 * MEASURED LIVE 2026-08-24, found by resolving receipts blind after a warming
 * sprint: dropping short words entirely meant "dog food" gated as ["food"],
 * "yoga mat" as ["yoga"] and "car seat" as ["seat"]. The dog food category
 * then stored CPSC recalls for pressure cookers and food processors, because
 * half the subject's identity had been silently discarded before any gate
 * ran. A short word cannot be a prefix ("mat" must never match "match"), but
 * it can be a word: "my dog will not eat this food" carries the subject and
 * must count. Words of one or two letters stay dropped.
 */
const SHORT_TERM_LENGTH = 3;

/* Three letter words that are grammar, not subject. "Rain guard for cars"
 * must not make "for" a subject term. Deliberately tiny: a word like "dog",
 * "car" or "gas" is exactly what this fix exists to keep. */
const FUNCTION_WORDS = new Set([
  'and', 'for', 'the', 'but', 'nor', 'per', 'via', 'its',
  'are', 'was', 'has', 'had', 'not',
]);

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
      .filter((w) => w.length >= MIN_TERM_LENGTH
        || (w.length === SHORT_TERM_LENGTH && !FUNCTION_WORDS.has(w))),
  )];
}

/*
 * How one term matches prose, shared by the record gate here and the
 * subreddit scorer, so the rule cannot mean two different things in one
 * codebase. Long terms match as word boundary prefixes, stem tolerant of a
 * trailing plural. Short terms match as exact words with an optional plural,
 * because a three letter prefix is a false friend factory: "mat" must find
 * "mats" and never "match".
 */
export function termMatchesProse(term: string, haystack: string): boolean {
  if (term.length < MIN_TERM_LENGTH) {
    return new RegExp(`\\b${term}s?\\b`, 'i').test(haystack);
  }
  if (new RegExp(`\\b${term}`, 'i').test(haystack)) return true;
  const stem = term.replace(/s$/, '');
  return stem !== term && stem.length >= MIN_TERM_LENGTH && new RegExp(`\\b${stem}`, 'i').test(haystack);
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
  const matched = terms.filter((t) => termMatchesProse(t, haystack));
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

  /*
   * The vocabulary a buyer uses when actually discussing the subject, guessed
   * by a model at plan time and used ONLY TO NARROW. On a subject of one
   * tokenizable word or none, a record whose own text never names the subject
   * must show at least one of these words to keep the pass its container
   * vouched for. Absent (offline, keyless, expansion failed), the gate
   * behaves exactly as it did without the field.
   */
  contextTerms?: string[];
}

/*
 * Does a record that passed on its container's word alone say anything about
 * the subject in its own words.
 *
 * WHY THE GATE ACCEPTS A MODEL'S GUESS HERE AND NOWHERE ELSE. The failure this
 * closes was measured 2026-08-23: a "love" run stored 2544 of 2544 records
 * seen, because every record in r/love passes a gate whose only requirement
 * the community name itself satisfies. The container was doing all the work,
 * and on a one word subject the container is about whatever it is about, not
 * the subject as asked.
 *
 * A context term requirement is safe where an expansion elsewhere would not
 * be, because it points one way. A record the current gate rejects is still
 * rejected: context terms are never consulted for it. A record the gate would
 * accept on the container's word must now also use one word a buyer would use
 * about the subject. Reality TV chatter in r/love carries none of the
 * vocabulary of any product and stops being evidence.
 *
 * APPLIED ONLY WHEN THE SUBJECT IS ONE TOKENIZABLE WORD OR NONE. Measured on
 * the evals/relevance sets, 2026-08-24: on "love" the check moved precision
 * from 0.286 to 0.500 at unchanged recall, and on "running shoes" it rejected
 * ZERO false positives while losing two real records, including the canonical
 * "Same, had to size up" (the model said "sizing", the text says "size", and
 * lexical matching cannot bridge them). The difference is the strength of the
 * vouch: a container carrying a two word subject in its name is a community
 * literally named for the subject, while a one word match is an accident of
 * naming, r/love or r/woolworths. So multi word subjects keep their vouch and
 * weak ones must hear the buyer's vocabulary in the record itself.
 *
 * Live smoke 2026-08-24, fresh corpora: a "love" run's reddit leg, where the
 * original failure stored everything, rejected 144 of 151 records and stored
 * 7. A "running shoes" control kept its container vouch, 1141 of 1141 reddit
 * records stored, findings unchanged. What remains on "love" is records whose
 * own text genuinely contains the word, which self vouch and are beyond any
 * lexical gate; the subject too broad sufficiency warning covers that class.
 */
function vouchedRecordSpeaksForItself(text: string, contextTerms: string[]): boolean {
  if (!contextTerms.length) return true;
  return scoreText(text, contextTerms).hits >= 1;
}

/*
 * The normalisation every caller must apply before handing buyer vocabulary
 * to the gate: the gate's own tokeniser, so the term length floor holds, and
 * subject words dropped, because a record whose text carries one vouches for
 * itself already and leaving them in would only dilute the requirement.
 * Shared so the evals harness cannot drift from what a run actually ships.
 */
export function normaliseContextTerms(raw: string[], subjectWords: string[]): string[] {
  const subject = new Set(subjectWords);
  return subjectTerms(raw).filter((t) => !subject.has(t));
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
  { minHits = 1, mode = 'terms', phrases = [], channelKind = 'title', contextTerms = [] }: RecordGateOptions = {},
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
  /*
   * MATCHED WORDS, NOT MATCH COUNTS. Summing hits let the channel and the
   * text each contribute the SAME word: measured live 2026-08-24, a CPSC
   * recall filed by "FoodState" about supplement bottles passed a "dog food"
   * gate because the channel matched "food", the text matched "food", and
   * one plus one cleared a requirement of two without "dog" appearing
   * anywhere. The requirement is coverage of the subject, so the sets are
   * united and the union is what counts: the channel is credited with the
   * part it really carries, and the record must supply the REST.
   */
  const channelMatched = channelKind === 'handle'
    ? scoreHandle(channel, terms).matched
    : scoreText(channel, terms).matched;

  /*
   * A PASS THE CONTAINER VOUCHED FOR MUST STILL SAY SOMETHING ITSELF, when
   * the subject is too weak to make the vouch mean anything. A record whose
   * own text carries a subject word vouches for itself and this is vacuously
   * true, as is any record under a multi word subject, whose container had to
   * carry the whole subject to vouch at all. Applied only on the accepting
   * paths where the container did the vouching; the paths that already
   * require the subject in the text satisfy it by construction. See
   * vouchedRecordSpeaksForItself for the measurement behind the scoping.
   */
  const textMatched = scoreText(text, terms).matched;
  const vouchOk = terms.length > 1 || textMatched.length > 0
    || vouchedRecordSpeaksForItself(text, contextTerms);

  /*
   * Strict mode, for general forums where a question term means whatever it
   * means to that audience. Requires the subject as a phrase, not as scattered
   * words. See matchesSubjectPhrase for the measurement behind this.
   */
  if (mode === 'phrase' && phrases.length) {
    /*
     * A handle is a squashed identifier and cannot carry prose, so the record
     * has to supply the phrase itself, AND has to be focused on it. Presence
     * alone let scraper dumps through: measured live 2026-08-24, the ten
     * longest github records stored for "running shoes" were 16,314 to 63,983
     * characters with one to three subject mentions each. One was an entire
     * scraped race site pasted into an issue, one was 66 Slickdeals listings
     * where a single listing named the subject, and an outside tester resolved
     * them behind a finding, which is the exact failure this gate exists to
     * prevent. The title branch below already applies the focus rule to off
     * topic threads; a handle container, which vouches for nothing, deserves
     * at least the same scrutiny. A 300 character issue naming the subject
     * once still passes; a 64K dump now needs ~160 mentions and dies.
     */
    if (channelKind !== 'title') {
      const needed = Math.max(1, Math.ceil(text.length / CHARS_PER_SUBJECT_MENTION));
      return countSubjectPhrase(text, phrases) >= needed;
    }

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
    if (scoreText(channel, terms).hits > 0 || matchesSubjectPhrase(channel, phrases)) return vouchOk;

    /* The thread is about something else, so the record has to be about the
     * subject on its own. See the note above on focus rather than repetition. */
    const needed = Math.max(1, Math.ceil(text.length / CHARS_PER_SUBJECT_MENTION));
    return countSubjectPhrase(text, phrases) >= needed;
  }

  /*
   * A subject too short to tokenize gates on nothing, which used to mean
   * everything passed silently. With planner vocabulary available, a record
   * at least has to sound like a buyer talking about the thing.
   */
  if (!terms.length) return vouchOk;

  const required = Math.max(minHits, Math.min(terms.length, 2));
  const covered = new Set([...textMatched, ...channelMatched]).size;
  return covered >= required && vouchOk;
}
