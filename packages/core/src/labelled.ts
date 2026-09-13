/*
 * Labelled breakdowns: what a source's OWN classification of its records says,
 * counted with receipts.
 *
 * WHY THIS IS A DIFFERENT KIND OF BLOCK FROM THEMES. Themes are phrases this
 * engine counted in the text, and the block says so: a candidate list, not a
 * claim. A label is a classification a named party attached to the record
 * before it reached us: the issue the CFPB filed a complaint under, how the
 * company closed it, whether it answered in time. Counting those is not a
 * guess about the words, it is a tally of what the regulator wrote down, and
 * every value carries the receipts that were counted so a reader can open
 * them.
 *
 * WHAT IT NEVER DOES. A label never promotes a claim, never weights a record,
 * and never prints a share over a denominator the reader cannot see: the
 * share is of the records that carry the key, and that total is printed
 * beside it. The corroboration threshold is untouched by anything here.
 *
 * DECLARED BY HAND, ON PURPOSE. A source that stores facets and is not listed
 * here is counted nowhere. Adding a source to the list is a decision about
 * what its labels mean, made once, in one place, with a title a reader sees.
 */

import type { CorpusDriver, SourceId } from '@quorum/corpus';

export interface LabelledValue {
  value: string;
  records: number;
  /* Of the records that carry this key, 0 to 1. The total is on the parent. */
  share: number;
  receiptIds: string[];
}

export interface LabelledBreakdown {
  source: SourceId;
  key: string;
  /* What a reader sees. Says whose classification this is. */
  title: string;
  /* Records in the category carrying this key at all: the denominator. */
  records: number;
  values: LabelledValue[];
}

export interface LabelledFacet {
  source: SourceId;
  key: string;
  title: string;
}

export const LABELLED_FACETS: readonly LabelledFacet[] = [
  { source: 'cfpb', key: 'issue', title: 'Issue, as the CFPB classified the complaint' },
  { source: 'cfpb', key: 'company_response', title: 'How the company closed it, per the CFPB' },
  { source: 'cfpb', key: 'timely', title: 'Answered within the deadline, per the CFPB' },
];

/*
 * Ten, because a breakdown of six complaints is six anecdotes with a
 * percentage sign on them. Below this the labels are still on every receipt a
 * reader opens; they are just not tallied as if they were a distribution.
 */
export const MIN_LABELLED_RECORDS = 10;

export interface LabelledOptions {
  minRecords?: number;
  /* Values per key, most records first. */
  valuesPerKey?: number;
  receiptsPerValue?: number;
  facets?: readonly LabelledFacet[];
}

export async function labelledBreakdowns(
  corpus: Pick<CorpusDriver, 'facetCounts'>,
  category: string,
  options: LabelledOptions = {},
): Promise<LabelledBreakdown[]> {
  const minRecords = options.minRecords ?? MIN_LABELLED_RECORDS;
  const facets = options.facets ?? LABELLED_FACETS;
  const out: LabelledBreakdown[] = [];
  for (const facet of facets) {
    const counts = await corpus.facetCounts(category, facet.key, {
      source: facet.source,
      limit: options.valuesPerKey ?? 8,
      receiptsPerValue: options.receiptsPerValue ?? 3,
    });
    const records = counts.reduce((n, c) => n + c.records, 0);
    if (records < minRecords) continue;
    out.push({
      source: facet.source,
      key: facet.key,
      title: facet.title,
      records,
      values: counts.map((c) => ({
        value: c.value,
        records: c.records,
        share: c.records / records,
        receiptIds: c.receiptIds,
      })),
    });
  }
  return out;
}
