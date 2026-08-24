import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc } from '@quorum/corpus';
import { countVoices, estimatedJaccard, textSignature } from './voices.ts';

let n = 0;
const doc = (text: string, over: Partial<Doc> = {}): Doc => ({
  receiptId: `rc_${String(n).padStart(16, '0')}`, source: 'reddit', kind: 'comment',
  externalId: `v${n++}`, category: 'c', channel: 'r/running', text,
  score: 1, url: 'https://e.test', createdUtc: 1, harvestedAt: 1, ...over,
});

test('identical texts are one voice, light edits included', () => {
  const paragraph =
    'These are honestly the best trail shoes I have ever owned, the grip on wet rock is unreal and the toe box finally fits my foot.';
  const copies = [
    doc(paragraph),
    doc(paragraph),
    doc(`${paragraph} Highly recommend.`),
  ];
  const voices = countVoices(copies);
  assert.equal(voices.independent, 1, 'twenty five hats, one voice');
  assert.equal(voices.collapsed, 2);
});

test('different comments about the same product are different voices', () => {
  const voices = countVoices([
    doc('The toe box is roomy but the heel slips on climbs, had to relace them twice.'),
    doc('Great grip on wet rock, terrible durability, the lugs were gone at 300km.'),
    doc('Sizing runs half a size small compared to the previous model in my experience.'),
  ]);
  assert.equal(voices.independent, 3);
  assert.equal(voices.collapsed, 0);
});

test('one receipt harvested under two categories is one candidate voice, not a duplicate', () => {
  const shared = doc('The midsole packs out after about 200 miles for me.');
  const other = { ...shared, category: 'trail shoes' };
  const voices = countVoices([shared, other]);
  assert.equal(voices.independent, 1);
  assert.equal(voices.collapsed, 0, 'the same receipt id is one candidate, never a collapsed copy');
});

test('the signature estimate separates near copies from mere topic overlap', () => {
  const template =
    'I am a bot and this action was performed automatically, please contact the moderators of this subreddit'
    + ' if you have any questions or concerns about why your post was removed from the queue today';
  const a = textSignature(template);
  const b = textSignature(template.replace('today', 'tonight'));
  const c = textSignature('the wiki has a faq about posting but honestly the bot never reads it');
  assert.ok(estimatedJaccard(a, b) >= 0.8, 'a one word edit in a long template stays the same voice');
  assert.ok(estimatedJaccard(a, c) < 0.8, 'shared vocabulary is not shared text');
});

test('a word swap in a very short text is a different voice, by design', () => {
  /*
   * Three word shingles make short texts edit sensitive: one swapped word in a
   * dozen changes a third of the shingles and lands well under the threshold.
   * That is the right direction to err. Collapsing two genuinely different
   * short comments would throw away real corroboration; letting a shuffled
   * short bot line through only leaves the raw count as it always was.
   */
  const a = textSignature('please read the wiki faq before posting, this bot message is automated');
  const b = textSignature('please read the wiki faq before posting, this bot message was automated');
  assert.ok(estimatedJaccard(a, b) < 0.8);
});

test('short texts can still be copypasta', () => {
  const voices = countVoices([doc('to the moon'), doc('to the moon'), doc('to the moon')]);
  assert.equal(voices.independent, 1);
  assert.equal(voices.collapsed, 2);
});
