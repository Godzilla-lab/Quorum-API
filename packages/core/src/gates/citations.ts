/*
 * Citation resolution. The gate the whole product rests on.
 *
 * A model is asked to write claims and to cite receipt ids for each one. It can
 * invent an id as easily as it can copy one, and an invented id is the worst
 * possible output here: it looks exactly like evidence, it survives casual
 * review, and it is discovered by a customer clicking a link that goes nowhere.
 *
 * So nothing a model says is trusted. Every id it cites is FETCHED BACK OUT OF
 * THE CORPUS before the claim is allowed near a report, and anything that does
 * not resolve is discarded.
 *
 * WHY FABRICATED IDS ARE DROPPED RATHER THAN THE WHOLE CLAIM REJECTED.
 *
 * Rejecting a claim outright because one of five citations was invented sounds
 * stricter and is worse. The other four receipts are real, and a real market
 * signal would be thrown away because of a model's clerical error.
 *
 * Dropping is not the soft option, because corroboration is RECOMPUTED on the
 * survivors. A claim that only reached the threshold with the help of two
 * invented ids now falls below it and is demoted. A fabricated id therefore
 * cannot contribute to a count under any circumstances, which is the property
 * that has to hold, and the fabrication is reported loudly rather than quietly
 * cleaned up.
 *
 * WHY A QUOTE IS CHECKED SEPARATELY FROM A CITATION.
 *
 * A model can cite a real record and still put words in its mouth. So any text
 * the model presents in quotation marks must actually appear in one of the
 * records it cited. "We cannot hallucinate a quote" is the sentence this
 * project sells, and it is only true if something checks.
 */

import type { CorpusDriver, Doc } from '@quorum/corpus';
import { corroborate, type Corroboration } from '../corroborate.ts';

export interface ModelClaim {
  /* What the model asserted, in its own words. */
  text: string;
  /* The question this answers, used to recompute corroboration. */
  term: string;
  /* Receipt ids the model says support it. Entirely untrusted. */
  receiptIds: string[];
}

export interface ResolvedClaim {
  text: string;
  term: string;
  /* Records that genuinely exist. The only thing a report may rely on. */
  receipts: Doc[];
  /* Recomputed over the survivors, never inherited from the model. */
  corroboration: Corroboration;
  /*
   * Ids the model cited that resolve to nothing. Non empty means the model
   * fabricated, and that is reported rather than tidied away.
   */
  fabricated: string[];
  /*
   * Quoted spans in the claim text that appear in none of the cited records.
   * Non empty means the model put words in a real person's mouth.
   */
  unsupportedQuotes: string[];
  /*
   * `finding`     enough real corroboration to state
   * `weak-signal` real evidence, not enough of it
   * `rejected`    the claim quoted something nobody said
   */
  verdict: 'finding' | 'weak-signal' | 'rejected';
}

/*
 * Quoted spans, straight and curly, plus the long dash free forms a model
 * reaches for. Anything under this length is a word in scare quotes rather than
 * a quotation, and flagging those would be noise.
 */
const MIN_QUOTE_LENGTH = 12;
const QUOTE_PATTERN = /"([^"]{12,400})"|“([^”]{12,400})”/g;

export function extractQuotes(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(QUOTE_PATTERN)) {
    const quote = (match[1] ?? match[2] ?? '').trim();
    if (quote.length >= MIN_QUOTE_LENGTH) out.push(quote);
  }
  return out;
}

/*
 * Whitespace and case are normalised because a model reflows a quote across
 * lines constantly, and that is not fabrication. Changing a WORD is.
 */
const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function quoteIsSupported(quote: string, records: readonly Doc[]): boolean {
  const needle = normalise(quote);
  return records.some((r) => normalise(r.text).includes(needle));
}

export interface ResolveOptions {
  minReceipts?: number;
}

export async function resolveCitations(
  claims: readonly ModelClaim[],
  corpus: CorpusDriver,
  options: ResolveOptions = {},
): Promise<ResolvedClaim[]> {
  /* One lookup for every id across every claim, rather than one per claim. */
  const wanted = [...new Set(claims.flatMap((c) => c.receiptIds))];
  const found = wanted.length ? await corpus.getByReceiptIds(wanted) : [];
  const byId = new Map(found.map((d) => [d.receiptId, d]));

  return claims.map((claim) => {
    const receipts: Doc[] = [];
    const fabricated: string[] = [];
    /* A model that cites the same id twice has not corroborated anything. */
    for (const id of new Set(claim.receiptIds)) {
      const doc = byId.get(id);
      if (doc) receipts.push(doc);
      else fabricated.push(id);
    }

    /* Recomputed over survivors. This is what makes dropping safe. */
    const corroboration = corroborate(claim.term, receipts, options);

    const unsupportedQuotes = extractQuotes(claim.text)
      .filter((q) => !quoteIsSupported(q, receipts));

    /*
     * A claim that quotes something nobody said is rejected outright, whatever
     * its corroboration. This is the one failure the product cannot have: a
     * real person shown saying words they did not write.
     */
    const verdict: ResolvedClaim['verdict'] = unsupportedQuotes.length
      ? 'rejected'
      : corroboration.verdict;

    return { text: claim.text, term: claim.term, receipts, corroboration, fabricated, unsupportedQuotes, verdict };
  });
}

/* Only what may be printed as a statement about the market. Provided so a
 * renderer cannot forget the filter. */
export function publishable(claims: readonly ResolvedClaim[]): ResolvedClaim[] {
  return claims.filter((c) => c.verdict === 'finding');
}

export interface FabricationReport {
  claimsChecked: number;
  idsCited: number;
  idsFabricated: number;
  quotesChecked: number;
  quotesUnsupported: number;
  claimsRejected: number;
  /* True when the model invented anything at all. */
  clean: boolean;
}

/* What the model tried to get away with, counted. A report carries this so a
 * customer can see the check ran rather than trusting that it did. */
export function fabricationReport(claims: readonly ResolvedClaim[]): FabricationReport {
  const idsCited = claims.reduce((n, c) => n + c.receipts.length + c.fabricated.length, 0);
  const idsFabricated = claims.reduce((n, c) => n + c.fabricated.length, 0);
  const quotesChecked = claims.reduce((n, c) => n + extractQuotes(c.text).length, 0);
  const quotesUnsupported = claims.reduce((n, c) => n + c.unsupportedQuotes.length, 0);
  return {
    claimsChecked: claims.length,
    idsCited,
    idsFabricated,
    quotesChecked,
    quotesUnsupported,
    claimsRejected: claims.filter((c) => c.verdict === 'rejected').length,
    clean: idsFabricated === 0 && quotesUnsupported === 0,
  };
}
