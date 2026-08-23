/*
 * Receipt ids: the public, permanent name for one piece of evidence.
 *
 * The engine mints ids as per run ordinals (`c12`, `p3`, `y4`, `v7`) from
 * counters that reset every run. Those are correct for the prompt, because they
 * are cheap in tokens and that is exactly why they exist. They cannot be the
 * public id: `GET /v1/evidence/:id` promises something that resolves forever,
 * and an ordinal resolves to a different record on the next run.
 *
 * So the public id is content addressed. Same record, same id, on every machine,
 * in both drivers, forever, with no coordination and no allocation table.
 */

import { createHash } from 'node:crypto';

/*
 * WHY 16 HEX CHARACTERS AND NOT 5.
 *
 * A receipt id collision means two different people's words share one id, so
 * resolving a claim returns the wrong human. That is the single worst failure
 * this product can produce, because the entire pitch is that the receipt is
 * real. It is worth spending characters on.
 *
 * Birthday bound, P(collision) ~= 1 - exp(-n^2 / 2^(bits+1)), computed 2026-08-22:
 *
 *   hex  bits        10k         1M        10M       100M
 *     5    20       ~1.0       ~1.0       ~1.0       ~1.0
 *    10    40    4.6e-05       0.37       ~1.0       ~1.0
 *    12    48    1.8e-07    1.8e-03       0.16       ~1.0
 *    16    64    2.7e-12    2.7e-08    2.7e-06    2.7e-04
 *
 * The 5 character form in the original API sketch collides with near certainty
 * before the corpus is even interesting. 10 characters fails at a million
 * records, which is a size this corpus is expressly designed to exceed. 16 holds
 * to a hundred million with room to spare, and `rc_` plus 16 is 19 characters,
 * which is still short enough to read aloud.
 */
const ID_HEX_CHARS = 16;
const ID_PREFIX = 'rc_';

/*
 * CATEGORY IS DELIBERATELY NOT IN THE HASH.
 *
 * `docs` is unique on (source, external_id, category), so the same comment
 * harvested while researching two different categories is two rows. If category
 * were part of the id, one human utterance would carry two receipt ids, and
 * corroboration counting would count that person twice.
 *
 * That would print a fabricated number under a claim ("31 people raised this"
 * when 30 did), which is precisely the failure the corroboration gate exists to
 * prevent. The id names the utterance. Category is a property of the row, not of
 * the evidence.
 */
export function receiptId(source: string, externalId: string): string {
  if (!source) throw new Error('receiptId needs a source');
  if (!externalId) throw new Error('receiptId needs an externalId');

  /*
   * NUL separated rather than concatenated. Without a separator, ("ab", "c")
   * and ("a", "bc") hash identically, which would let a YouTube comment collide
   * with a Reddit one by coincidence of string lengths. NUL cannot appear in
   * either field, so it is an unambiguous boundary.
   */
  const digest = createHash('sha256')
    .update(source, 'utf8')
    .update('\0', 'utf8')
    .update(externalId, 'utf8')
    .digest('hex');

  return ID_PREFIX + digest.slice(0, ID_HEX_CHARS);
}

const ID_PATTERN = new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX_CHARS}}$`);

/*
 * Shape check only. A well formed id that names nothing still resolves to
 * nothing, and that is the resolver's job, not this function's. Used to reject
 * obvious junk before it reaches a database query.
 */
export function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
