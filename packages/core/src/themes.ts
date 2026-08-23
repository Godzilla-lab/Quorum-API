/*
 * What the corpus is actually about, as opposed to what it was asked about.
 *
 * THE DEFECT THIS EXISTS TO FIX, MEASURED 2026-08-22.
 *
 * A knee brace run stored twelve real FDA enforcement reports and then answered
 * "no evidence" to every question, because a recall says "sterile barrier
 * compromised" and the caller had typed "defects". The strongest evidence in
 * the corpus was held and never shown. Surfacing attested records fixed that
 * one case. This is the general fix: a report that can only answer the question
 * it was handed is a search box, and the caller's terms are a guess.
 *
 * THIS IS A HEURISTIC AND IT IS PUBLISHED AS ONE.
 *
 * Same doctrine as `brandCandidates`: the extraction does not need to be clean,
 * because every theme carries the receipts it came from. A reader who thinks
 * "difference between" is not a theme can fetch the records and see that for
 * themselves in one request. No receipt, no claim, including for a claim made
 * by a word counter.
 *
 * RANKED BY DISTINCT CHANNELS, WHICH IS THE MEASUREMENT THAT MADE IT WORK.
 *
 * Ranking by frequency returned automod boilerplate and nothing else. On a real
 * 1,181 record corpus the top phrases by count were "utm source", "wiki faq",
 * "rules app", "bot message" and "readtherulesapp comments": one subreddit's
 * automoderator, repeated. Every one of them sat in ONE channel. The real
 * themes sat in many: "high quality" in 18, "trail running" in 7, "hiking
 * boots" in 4.
 *
 * So the discriminator is spread, not volume, and that is the same thing
 * corroboration has always believed: a phrase repeated twenty five times by one
 * bot is one voice. Requiring two channels removed the boilerplate completely,
 * with no blocklist of bot phrases to maintain.
 */

import { MIN_RECEIPTS } from '@receipts/corpus/constants';
import type { Doc } from '@receipts/corpus';
import { isBotBoilerplate } from '@receipts/sources';
import { corroborate, type Corroboration } from './corroborate.ts';

export interface Theme {
  /* One or two words, as people wrote them. */
  phrase: string;
  /* Distinct receipts, never total mentions. One person saying it six times is
   * one voice, and the whole product rests on not counting them as a crowd. */
  records: number;
  channels: number;
  /* The receipts, so a heuristic's output can be checked rather than believed. */
  receiptIds: string[];
  /* Run through the same gate as everything else, so there is exactly one
   * definition of "enough" in this codebase. */
  corroboration: Corroboration;
}

/*
 * Function words, and the conversational furniture that behaves like them.
 *
 * A phrase is dropped if ANY of its words is in here, which is a much more
 * robust rule than a blocklist of bad phrases. Measured on real text: it killed
 * "for the", "you can", "thank you", "your post" and "read the" in one pass,
 * and no curated list of bigrams would have kept up.
 */
const STOP = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'another', 'any',
  'anyone', 'anything', 'are', 'around', 'as', 'at', 'back', 'be', 'because', 'been',
  'before', 'being', 'best', 'better', 'between', 'both', 'but', 'by', 'came', 'can',
  'cant', 'come', 'comes', 'could', 'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt',
  'doing', 'done', 'dont', 'down', 'each', 'else', 'enough', 'even', 'ever', 'every',
  'everyone', 'few', 'find', 'finds', 'first', 'for', 'found', 'from', 'get', 'gets',
  'getting', 'give', 'given', 'go', 'goes', 'going', 'gone', 'good', 'got', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'however',
  'i', 'if', 'im', 'in', 'into', 'is', 'isnt', 'it', 'its', 'ive', 'just', 'keep',
  'kind', 'know', 'known', 'knows', 'last', 'least', 'less', 'let', 'like', 'liked',
  'likes', 'little', 'lot', 'lots', 'made', 'make', 'makes', 'making', 'many', 'may',
  'maybe', 'me', 'might', 'mind', 'more', 'most', 'much', 'must', 'my', 'need',
  'needed', 'needs', 'never', 'new', 'next', 'no', 'nope', 'nor', 'not', 'nothing',
  'now', 'of', 'off', 'often', 'ok', 'okay', 'old', 'on', 'once', 'one', 'only', 'or',
  'other', 'others', 'our', 'out', 'over', 'own', 'part', 'people', 'per', 'person',
  'place', 'point', 'put', 'quite', 'rather', 'really', 'right', 'said', 'same', 'saw',
  'say', 'says', 'see', 'seem', 'seems', 'seen', 'set', 'she', 'should', 'since', 'so',
  'some', 'someone', 'something', 'sometimes', 'still', 'stuff', 'such', 'sure',
  'take', 'takes', 'than', 'that', 'thats', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'think', 'thinks', 'this', 'those', 'though',
  'through', 'to', 'told', 'too', 'took', 'try', 'trying', 'two', 'under', 'until',
  'up', 'us', 'use', 'used', 'using', 'usually', 'very', 'want', 'wanted', 'wants',
  'was', 'wasnt', 'way', 'ways', 'we', 'well', 'went', 'were', 'what', 'when', 'where',
  'whether', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'without', 'wont',
  'work', 'works', 'would', 'wouldnt', 'yeah', 'yes', 'yet', 'you', 'your', 'youre',
  'yours',
  /* Post furniture, which survives the grammar rule because it is nouns. */
  'edit', 'tldr', 'thanks', 'thank', 'please', 'sorry', 'post', 'posts', 'comment',
  'comments', 'thread', 'sub', 'subreddit', 'reddit', 'link', 'links', 'https', 'http',
  'www', 'com', 'net', 'org', 'html', 'utm',
  /* Units of time, which pair with everything and mean nothing on their own. */
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'time', 'times',
  /*
   * Intensifiers and hedges, added after reading real output on 2026-08-22.
   * They survive the grammar rule because they are adverbs and adjectives
   * rather than function words, and they pair with anything: the first pass
   * offered "almost always", "pretty hard" and "big deal" as themes.
   */
  'almost', 'already', 'always', 'actually', 'basically', 'definitely', 'entirely',
  'especially', 'exactly', 'far', 'generally', 'honestly', 'immediately', 'literally',
  'mostly', 'nearly', 'obviously', 'perhaps', 'possibly', 'probably', 'seriously',
  'simply', 'slightly', 'totally', 'truly', 'kinda', 'sorta', 'gonna', 'wanna',
  /*
   * NOTE ON WHAT IS DELIBERATELY ABSENT: `long`, `high`, `pair`, `big`, `buy`.
   *
   * They were in this list for one iteration, added to stop them ranking as
   * single word themes. Removed once phrases were ranked above words, because
   * that change already buries a noisy word and stop listing these cost real
   * phrases: "long run", "high quality" and "bought pair" were all measured on
   * a real corpus and all disappeared. Precision on single words is worth less
   * than recall on phrases, since a phrase is the thing a reader can act on.
   */
]);

/*
 * A deliberately crude stem, used ONLY to decide whether a phrase repeats a
 * word the caller already asked about. It is never shown to anyone.
 *
 * Crude on purpose: a real stemmer is a dependency, and the cost of being wrong
 * here is that a theme is either shown twice under two spellings or hidden once.
 * Neither is a wrong number, which is the only kind of mistake that matters.
 */
function stem(word: string): string {
  let root = word;
  if (root.length > 5 && root.endsWith('ing')) root = root.slice(0, -3);
  else if (root.length > 4 && root.endsWith('ed')) root = root.slice(0, -2);
  else if (root.length > 4 && root.endsWith('es')) root = root.slice(0, -2);
  else if (root.length > 3 && root.endsWith('s')) root = root.slice(0, -1);
  /*
   * A trailing `e` and a doubled consonant, both left behind by the rules
   * above. Without them "size" stems to `size` while "sizing" stems to `siz`,
   * so a caller who typed `size` was offered `sizing` straight back as a
   * discovery. Same for "run" against "running", which left `runn`.
   */
  if (root.length > 3 && root.endsWith('e')) root = root.slice(0, -1);
  if (root.length > 2 && root[root.length - 1] === root[root.length - 2]) root = root.slice(0, -1);
  return root;
}

/*
 * Apostrophes are removed rather than treated as separators, and that is a bug
 * fix. Splitting on them turned "don't" into "don" plus a one letter token that
 * was then dropped, so a real corpus offered "don run" and "don mind" as
 * themes. Joined, it becomes "dont", which the stop list already knows.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    /* Urls first, or their query strings become themes. Measured: "utm source",
     * "utm medium" and "wiki faq" all ranked above real phrases. */
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/* Content words only. Exported because callers pass subject strings through the
 * same normalisation the corpus text went through. */
export function words(text: string): string[] {
  return tokenise(text).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

export interface ThemeOptions {
  /*
   * Words the caller already asked about, plus the subject's own words. A
   * report headed "running shoes" listing "running shoes" as a discovered theme
   * is noise, and answering a term twice is worse than not answering it.
   */
  exclude?: readonly string[];
  /*
   * Two, and it is the whole reason this works. See the header: everything the
   * frequency ranking surfaced was one channel's automoderator.
   */
  minChannels?: number;
  minRecords?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 8;

export function discoverThemes(records: readonly Doc[], options: ThemeOptions = {}): Theme[] {
  const minChannels = options.minChannels ?? 2;
  const minRecords = options.minRecords ?? MIN_RECEIPTS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const excluded = new Set((options.exclude ?? []).flatMap((term) => words(term)).map(stem));
  const usable = (word: string): boolean =>
    word.length >= 3 && !/^\d+$/.test(word) && !STOP.has(word) && !excluded.has(stem(word));

  /* Receipt ids per phrase, deduped: the same utterance harvested under two
   * categories is two rows and one voice. */
  const seenBy = new Map<string, Set<string>>();
  const docsFor = new Map<string, Map<string, Doc>>();

  /*
   * BOT BOILERPLATE IS EXCLUDED HERE TOO, NOT ONLY ON THE WAY IN.
   *
   * The adapter now refuses these, but a corpus harvested before that fix still
   * holds them, and a corpus is kept forever by design. Filtering only at write
   * time would leave every existing archive permanently wrong.
   *
   * Requiring two channels was not enough on its own, and finding that out took
   * a real run: an automoderator posts in every subreddit it moderates, so its
   * channel spread is real. Spread separates a crowd from one person. It cannot
   * separate a crowd from a robot, and nothing about counting can.
   */
  const distinct = records.filter((r) => !isBotBoilerplate(r.text));

  for (const record of distinct) {
    /*
     * EVERY token, including the short ones, and a pair is only formed from
     * words that were genuinely NEXT TO EACH OTHER.
     *
     * Filtering first and pairing afterwards invents phrases nobody wrote. On
     * "the toe box is narrow", dropping `is` for being two letters long made
     * `box` and `narrow` adjacent, and the report offered "box narrow" as
     * something the market says. Fabricating a phrase is the one thing this
     * product cannot do, and it does not stop being fabrication because a word
     * counter did it rather than a model.
     */
    const tokens = tokenise(record.text);
    /* Per record, so one comment repeating a phrase six times counts once. */
    const phrases = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i]!;
      if (!usable(word)) continue;
      phrases.add(word);
      const next = tokens[i + 1];
      if (next && usable(next)) phrases.add(`${word} ${next}`);
    }
    for (const phrase of phrases) {
      let ids = seenBy.get(phrase);
      if (!ids) { ids = new Set(); seenBy.set(phrase, ids); }
      ids.add(record.receiptId);
      let docs = docsFor.get(phrase);
      if (!docs) { docs = new Map(); docsFor.set(phrase, docs); }
      docs.set(record.receiptId, record);
    }
  }

  const candidates: Theme[] = [];
  for (const [phrase, ids] of seenBy) {
    if (ids.size < minRecords) continue;
    const docs = [...docsFor.get(phrase)!.values()];
    const channels = new Set(docs.map((d) => d.channel).filter(Boolean)).size;
    if (channels < minChannels) continue;
    candidates.push({
      phrase,
      records: ids.size,
      channels,
      receiptIds: [...ids],
      corroboration: corroborate(phrase, docs),
    });
  }

  /*
   * ONE ENTRY PER PHRASE, NOT ONE PER SPELLING.
   *
   * "long run" and "long runs" are the same theme and listing both spends two
   * of eight slots saying one thing. Merged on the crude stem, keeping the
   * spelling more people actually used.
   */
  const byStem = new Map<string, Theme>();
  for (const candidate of candidates) {
    const key = candidate.phrase.split(' ').map(stem).join(' ');
    const existing = byStem.get(key);
    if (!existing) { byStem.set(key, candidate); continue; }
    const ids = new Set([...existing.receiptIds, ...candidate.receiptIds]);
    const winner = candidate.records > existing.records ? candidate : existing;
    byStem.set(key, {
      ...winner,
      /* Counts are recomputed over the union, never added: the same record can
       * contain both spellings and adding would count one voice twice. */
      records: ids.size,
      channels: Math.max(existing.channels, candidate.channels),
      receiptIds: [...ids],
    });
  }

  /*
   * A TWO WORD PHRASE OUTRANKS ANY SINGLE WORD, AND THAT IS NOT A PREFERENCE.
   *
   * Measured 2026-08-22: ranking them together by channel spread put every
   * single word on top, because a common word appears in more channels than any
   * specific phrase containing it, BY CONSTRUCTION. The first real run returned
   * "pair", "high", "actually" and "theyre" as the themes of a running shoe
   * corpus, while "toe box" and "hiking boots" were ranked below them.
   *
   * No stop list fixes that, because the problem is not which words are in the
   * list, it is that the two kinds of candidate are not comparable on the same
   * scale. A phrase is self describing and a single common word is not.
   */
  /*
   * A SINGLE WORD IS DROPPED WHEN A PHRASE CARRIES IT.
   *
   * "arch support" says something and "arch" alone barely does, so listing both
   * spends two slots on one idea. Dropped only when the phrase reaches AT LEAST
   * as many channels, which is the case where the phrase is carrying the signal
   * rather than being a fragment of a broader word.
   *
   * Ranking phrases first is not a substitute for this and losing it was a real
   * regression: a live diff announced "new topics: toe box, box, toe", which is
   * one topic reported three times.
   */
  const merged = [...byStem.values()];
  const phrases = merged.filter((t) => t.phrase.includes(' '));
  const kept = merged.filter((theme) => {
    if (theme.phrase.includes(' ')) return true;
    return !phrases.some(
      (p) => p.channels >= theme.channels && p.phrase.split(' ').includes(theme.phrase),
    );
  });

  const rank = (theme: Theme): number => (theme.phrase.includes(' ') ? 0 : 1);
  return kept
    .sort((a, b) => rank(a) - rank(b)
      || b.channels - a.channels
      || b.records - a.records
      || a.phrase.localeCompare(b.phrase))
    .slice(0, limit);
}

/*
 * Themes worth printing as something the market raised on its own, rather than
 * as a word that appeared often. Uses the shared gate, so a theme is promoted
 * on exactly the same evidence a claim is.
 */
export function notableThemes(themes: readonly Theme[]): Theme[] {
  return themes.filter((t) => t.corroboration.verdict === 'finding');
}
