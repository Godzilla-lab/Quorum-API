/*
 * Who makes this thing, according to the market.
 *
 * THE PROBLEM THIS SOLVES, MEASURED 2026-08-22.
 *
 * Finding a product from its name worked only when the brand was the first
 * word. "Allbirds Wool Runner" resolved to a real product with a real price.
 * Bare names did not, and bare names are how people actually search:
 *
 *   wool runner                   0 of 3 guessed domains had a catalogue
 *   merino wool sneakers          0 of 3
 *   tri blend crew sock           0 of 3
 *   bamboo toothbrush             0 of 3
 *   magnesium glycinate gummies   0 of 3
 *
 * Five for five. Guessing `wool.com` from "wool runner" is not a strategy.
 *
 * THE FIX USES AN ASSET WE ALREADY HAVE. The voice corpus is full of people
 * naming brands, because that is what people do when they discuss products. On
 * a real 411 record corpus for "running shoes", ranking capitalised tokens by
 * how many DISTINCT records mention them surfaced Runna at 25, Garmin at 9,
 * Nike at 9, Brooks at 7 and Adidas at 6.
 *
 * WE DO NOT NEED THE EXTRACTION TO BE CLEAN, BECAUSE EVERY CANDIDATE IS THEN
 * VERIFIED AGAINST A REAL CATALOGUE. A wrong guess costs one request that finds
 * nothing. That is why this is a ranked candidate list and not a classifier:
 * cheap recall plus hard verification beats trying to be right first time.
 */

/*
 * Counted by DISTINCT RECORDS, never by total mentions. One person writing
 * "Nike" six times in a rant is one voice, and the whole product rests on not
 * counting one person as a crowd.
 */
export interface BrandCandidate {
  name: string;
  /* Distinct records that mentioned it. */
  records: number;
  /* Distinct channels, so a brand named across many places outranks a thread. */
  channels: number;
  /*
   * THE RECEIPTS. Added 2026-08-22 after an audit of our own output.
   *
   * This shipped as `{name, records, channels}`: a count, presented to a reader
   * as "brands the market named", with nothing behind it to check. A real run
   * returned Google, American, China, Clark and Ignition as brands for running
   * shoes, because the extractor is a capitalised word heuristic and nothing
   * downstream could contradict it.
   *
   * No receipt, no claim. This is a candidate list produced by a heuristic, and
   * the only honest way to publish a heuristic's output is to hand over the
   * records it came from so a reader can see for themselves that "China" was
   * never a brand.
   */
  receiptIds: string[];
}

/*
 * Words that are capitalised for reasons other than being a brand.
 *
 * Sentence openers dominate this list, and they are handled structurally as
 * well: a capitalised word that is NOT at the start of a sentence is a much
 * stronger proper noun signal, and this file weights it accordingly.
 */
const NOT_BRANDS = new Set([
  'the', 'i', 'it', 'but', 'and', 'my', 'if', 'so', 'this', 'that', 'you', 'we', 'they',
  'in', 'for', 'on', 'at', 'to', 'is', 'was', 'not', 'no', 'yes', 'what', 'when', 'why',
  'how', 'there', 'then', 'also', 'just', 'now', 'do', 'did', 'have', 'has', 'had',
  'would', 'could', 'should', 'one', 'two', 'some', 'most', 'more', 'very', 'really',
  'even', 'only', 'still', 'much', 'been', 'its', 'he', 'she', 'his', 'her', 'their',
  'our', 'your', 'me', 'them', 'us', 'as', 'of', 'or', 'be', 'are', 'were', 'will',
  'can', 'may', 'get', 'got', 'go', 'went', 'like', 'well', 'good', 'great', 'best',
  'new', 'old', 'same', 'other', 'than', 'because', 'after', 'before', 'over', 'under',
  'about', 'into', 'out', 'up', 'down', 'off', 'per', 'both', 'each', 'any', 'all',
  'every', 'which', 'who', 'whom', 'where', 'while', 'since', 'until', 'though',
  'although', 'however', 'actually', 'honestly', 'basically', 'edit', 'tldr', 'yeah',
  'nope', 'thanks', 'thank', 'please', 'sorry', 'hey', 'hi', 'hello',
  /*
   * Moderator and bot furniture. Measured on the same corpus: "Click", "Read",
   * "Rules", "Dear", "Submit" and "ReadTheRulesApp" all outranked real brands,
   * because automod messages are high volume and formulaic. The comment filter
   * upstream misses some of them, so this list is a second line of defence.
   */
  'click', 'read', 'rules', 'dear', 'submit', 'moderator', 'moderators', 'automod',
  'removed', 'deleted', 'post', 'posts', 'comment', 'comments', 'subreddit', 'sub',
  'thread', 'message', 'contact', 'questions', 'concerns', 'action', 'performed',
  'automatically', 'bot', 'faq', 'wiki', 'link', 'links',
  /*
   * Regulatory furniture, measured 2026-08-22 the first time an attested source
   * was wired in. A CPSC only run offered "Due", "Recall", "CPSC" and "Fire" as
   * brands, because recall titles are as formulaic as automod messages: every
   * one of them says "X Recalls Y Due to Fire Hazard".
   *
   * The agency names themselves matter most. A regulator is never the brand
   * being researched, and it appears in every single record from its own feed,
   * so without this it outranks every real company by construction.
   */
  'recall', 'recalls', 'recalled', 'hazard', 'hazards', 'due', 'announce', 'announces',
  'cpsc', 'nhtsa', 'fda', 'consumer', 'commission', 'safety', 'administration',
  'injury', 'injuries', 'repair', 'refund', 'remedy', 'model', 'models', 'units',
  'sold', 'exclusively', 'nationwide', 'inc', 'llc', 'ltd', 'corp', 'company',
  /*
   * Interjections, which are capitalised mid sentence because people shout
   * them. A live "running shoes" report on 2026-08-23 offered "Wow" as a
   * candidate brand on the strength of three excited comments.
   */
  'wow', 'lol', 'omg', 'ugh', 'huh', 'hmm', 'haha', 'wtf',
  /*
   * Model tier words, from the same 2026-08-23 report, which offered "Pro"
   * and "Elite". They are capitalised because they are part of SOME OTHER
   * product's name: the Pro in "AirPods Pro" is real and is still never the
   * brand being researched. A company genuinely named one of these words
   * loses its candidacy here and keeps every other route in, which is the
   * right price for never printing "Pro" as a market named brand again.
   */
  'pro', 'elite', 'max', 'plus', 'ultra', 'mini', 'lite', 'premium', 'sport',
]);

export interface BrandRecord {
  text: string;
  channel?: string;
  /*
   * The record this text came from. Optional only because the extractor is also
   * used on text that is not yet a corpus row; wherever a caller has the id, it
   * must pass it, or the candidate it gets back is a claim with no receipt.
   */
  receiptId?: string;
}

export interface BrandOptions {
  /* Words from the subject itself, which are never the brand. */
  exclude?: readonly string[];
  /* A brand named in only one record is a mention, not a signal. */
  minRecords?: number;
  limit?: number;
}

/* A capitalised word that opens a sentence proves nothing. One mid sentence is
 * a proper noun almost every time. */
const CAPITALISED = /(^|[^.!?\n]\s+)([A-Z][a-zA-Z]{2,14})\b/g;
const SENTENCE_START = /(?:^|[.!?]\s+)([A-Z][a-zA-Z]{2,14})\b/g;

export function brandCandidates(
  records: readonly BrandRecord[],
  options: BrandOptions = {},
): BrandCandidate[] {
  const excluded = new Set((options.exclude ?? []).map((w) => w.toLowerCase()));
  const minRecords = options.minRecords ?? 2;
  const limit = options.limit ?? 8;

  const strong = new Map<string, { records: Set<number>; channels: Set<string>; receipts: Set<string> }>();
  const weak = new Map<string, number>();

  records.forEach((record, index) => {
    const midSentence = new Set<string>();
    for (const m of record.text.matchAll(CAPITALISED)) {
      const token = m[2]!;
      const key = token.toLowerCase();
      if (NOT_BRANDS.has(key) || excluded.has(key)) continue;
      midSentence.add(token);
    }
    for (const m of record.text.matchAll(SENTENCE_START)) {
      const key = m[1]!.toLowerCase();
      if (NOT_BRANDS.has(key) || excluded.has(key)) continue;
      if (!midSentence.has(m[1]!)) weak.set(key, (weak.get(key) ?? 0) + 1);
    }

    for (const token of midSentence) {
      const entry = strong.get(token) ?? { records: new Set<number>(), channels: new Set<string>(), receipts: new Set<string>() };
      entry.records.add(index);
      if (record.channel) entry.channels.add(record.channel);
      if (record.receiptId) entry.receipts.add(record.receiptId);
      strong.set(token, entry);
    }
  });

  return [...strong]
    .map(([name, e]) => ({ name, records: e.records.size, channels: e.channels.size, receiptIds: [...e.receipts] }))
    .filter((c) => c.records >= minRecords)
    /* Channel spread first: a brand named across five communities is a market
     * fact, one named five times in a single thread is a conversation. */
    .sort((a, b) => b.channels - a.channels || b.records - a.records || a.name.localeCompare(b.name))
    .slice(0, limit);
}
