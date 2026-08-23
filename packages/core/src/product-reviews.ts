/*
 * Reviews found in a product page's own markup, turned into corpus records.
 *
 * FOUND BY LOOKING FOR WHAT WE ALREADY HAD, 2026-08-22.
 *
 * `extractProductFacts` has parsed `schema.org/Review` blocks out of product
 * pages since the day it was written, and `Subject.reviews` has carried them
 * ever since. Nothing anywhere consumed the field. Every run that resolved a
 * product page pulled real customer reviews out of the markup and dropped them
 * on the floor, while the report went off to ask a forum what people thought.
 *
 * This is the same class of defect as the attested records that were stored and
 * never shown: evidence retrieved, held, and never reaching the reader.
 *
 * WHY THIS IS NOT A `Source` ADAPTER.
 *
 * A Source fetches. These reviews arrive as a side effect of resolving the
 * subject, which has already fetched the page. Wrapping them in an adapter
 * would fetch the same page twice to read a field we are already holding.
 *
 * WHY THEY ARE NOT PUT THROUGH THE RELEVANCE GATE.
 *
 * Every other record has to prove it is about the subject, because it came from
 * a search that could return anything. These came from the product's own page.
 * They are about the product by construction, and gating them would drop the
 * best ones: a review saying "runs small, order a size up" never names the
 * product, because the reader already knows what page they are on.
 *
 * Judge.me, Okendo and Junip all emit this markup by default, so one parser
 * reads reviews across thousands of stores with no vendor API, no key and no
 * authentication.
 */

import { createHash } from 'node:crypto';
import type { DocInput } from '@receipts/corpus';

export interface ExtractedReview {
  text: string;
  rating?: number | undefined;
  author?: string | undefined;
}

export interface ReviewSubject {
  url?: string | undefined;
  reviews: ExtractedReview[];
}

/* Short enough to be a fragment rather than an opinion. Matches the floor the
 * forum adapters use, so one source cannot sneak in shorter evidence. */
const MIN_REVIEW_LENGTH = 40;

/*
 * A stable id for a review that has none.
 *
 * Page markup carries no review id, and the receipt id is derived from the
 * external id, so an unstable one would mint a new receipt on every run and the
 * same person would be counted twice. Content addressing makes a re-read of the
 * same page produce the same id forever, which is exactly what upserting needs.
 *
 * The author is included because two people can leave the same short review,
 * and collapsing them would undercount rather than overcount.
 */
export function reviewExternalId(review: ExtractedReview): string {
  return createHash('sha256')
    .update(review.author ?? '', 'utf8')
    .update('\0', 'utf8')
    .update(review.text, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/*
 * The store the page was on, which is the unit of independence here. Reviews on
 * one brand's own site are one channel: a brand chooses what appears there, and
 * fifty five star reviews it selected are not fifty independent observations.
 */
export function reviewChannel(url: string | undefined): string {
  if (!url) return 'product page';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'product page';
  }
}

export function productReviewDocs(subject: ReviewSubject): DocInput[] {
  const seen = new Set<string>();
  const channel = reviewChannel(subject.url);
  const docs: DocInput[] = [];

  for (const review of subject.reviews) {
    const text = review.text.replace(/\s+/g, ' ').trim();
    if (text.length < MIN_REVIEW_LENGTH) continue;

    const externalId = reviewExternalId({ ...review, text });
    /* The same review rendered twice on a page, which happens when markup is
     * emitted per widget as well as per product. */
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    docs.push({
      source: 'review',
      kind: 'comment',
      externalId,
      channel,
      text,
      /*
       * Stars, one to five, and zero when the markup carried no rating. The
       * score kind table marks this source as `stars` so a renderer never
       * prints "2 points" under a two star review.
       */
      score: Number.isInteger(review.rating) && (review.rating ?? 0) >= 1 && (review.rating ?? 0) <= 5
        ? (review.rating as number)
        : 0,
      url: subject.url ?? '',
      /*
       * Zero, honestly. schema.org has a `datePublished` and most stores do not
       * emit it, and the extractor does not read it today. An invented date
       * would be worse than an absent one.
       */
      createdUtc: 0,
    });
  }

  return docs;
}
