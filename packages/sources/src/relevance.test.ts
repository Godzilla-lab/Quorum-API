import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreHandle, isRelevantRecord, matchesSubjectPhrase, scoreText, subjectTerms } from './relevance.ts';

/*
 * The SUBJECT only. Note what is deliberately absent: "sizing", "comfort" and
 * the other question terms. Gating on a word you searched for passes everything
 * by construction, which is how "RISC vs CISC and instruction sizing tradeoffs"
 * first slipped through this very test.
 */
const TERMS = subjectTerms(['running shoes']);

test('the subject is the category, never the question terms', () => {
  assert.deepEqual(TERMS, ['running', 'shoes']);
  assert.equal(TERMS.includes('sizing'), false, 'searching for sizing then gating on sizing is circular');
});

test('subject terms drop short words that would match anything', () => {
  assert.deepEqual(subjectTerms(['running shoes']), ['running', 'shoes']);
  assert.deepEqual(subjectTerms(["men's tee"]), [], 'men and tee are both too short to be safe');
  assert.deepEqual(subjectTerms(['a to at the']), []);
});

test('duplicate words across phrases become one term', () => {
  assert.deepEqual(subjectTerms(['running shoes', 'running gear']), ['running', 'shoes', 'gear']);
});

/*
 * THE REGRESSION. Measured 2026-08-22 on a live run: a "running shoes" report
 * searched Hacker News for the bare term "sizing" and stored 95 threads about
 * CSS and web servers, then reported them as corroborating channels.
 */
test('off topic records from a free text search are rejected', () => {
  const offTopic = [
    ['Grid Style Sheets, replace CSS with a constraint solver', 'Grid Style Sheets'],
    ['Microsoft is killing off the Internet Explorer brand', 'Microsoft is killing off the IE brand'],
    ['RISC vs CISC and instruction sizing tradeoffs', 'RISC vs. CISC: Whats the Difference?'],
    ['font sizing in responsive layouts is still a mess', 'Highlighter.js'],
  ];
  for (const [text, channel] of offTopic) {
    assert.equal(isRelevantRecord(text!, channel!, TERMS), false, `stored anyway: ${text!.slice(0, 40)}`);
  }
});

test('on topic records are kept', () => {
  /* The channel carries "running", the text carries "shoes". Between them the
   * whole subject is accounted for, which is the normal shape. */
  assert.equal(isRelevantRecord('These shoes run small, I sized up half a size', 'r/running', TERMS), true);

  /* A story title that carries the subject vouches for the comments under it,
   * which is where Hacker News voice of customer actually lives. */
  assert.equal(
    isRelevantRecord('I have three pairs and they all wear through at the heel',
      'The Great Barefoot Running Shoe Hysteria of 2010', TERMS),
    true,
  );
});

/*
 * DELIBERATELY CHANGED 2026-08-22, and the old expectation is recorded because
 * it looks reasonable and is not.
 *
 * This used to assert that "The Great Barefoot Running Hysteria of 2010" was
 * kept with a channel carrying nothing. It carries one word of a two word
 * subject, and that is the exact shape that let a Brooks Glycerin review into a
 * "wool runner" report: one subject word, no supporting container, stored as
 * evidence.
 *
 * It is topically related, and we cannot tell that lexically. Being consistent
 * about the rule matters more than rescuing one example, because the rule is
 * what stops the failures we have actually measured.
 */
test('one subject word with nothing supporting it is not enough', () => {
  assert.equal(isRelevantRecord('The Great Barefoot Running Hysteria of 2010', 'HN thread', TERMS), false);
});

/*
 * A comment inside an obviously on topic thread is on topic even when the
 * sentence itself says nothing. This is most of the good voice of customer.
 */
test('an elliptical comment in an on topic thread is kept', () => {
  assert.equal(
    isRelevantRecord('Same, had to go up half a size', 'These running shoes are too narrow', TERMS),
    true,
    'the thread carries the subject when the sentence does not',
  );
  assert.equal(
    isRelevantRecord('Same, had to go up half a size', 'Ask HN: best CI runner', TERMS),
    false,
    'and without an on topic thread it says nothing at all',
  );
});

test('the gate counts terms and never divides by how many there are', () => {
  const many = subjectTerms(['running shoes', 'trail shoes', 'road shoes', 'racing flats']);
  assert.equal(
    isRelevantRecord('these shoes run small', 'r/running', many),
    true,
    'one match out of many terms is still a match, or a better planner makes the gate stricter',
  );
});

test('prefix matching does not fire inside an unrelated word', () => {
  assert.equal(scoreText('subreddit moderation', ['reddit']).hits, 0, 'no word boundary before reddit');
  assert.equal(scoreText('shoemaking as a hobby', ['shoe']).hits, 1, 'but a genuine prefix counts');
});

test('with no subject terms nothing is filtered, rather than everything', () => {
  assert.equal(isRelevantRecord('anything at all', 'anywhere', []), true, 'an empty gate must not empty the corpus');
});

test('minHits can be raised for a noisier source', () => {
  const text = 'these shoes run small';
  assert.equal(isRelevantRecord(text, 'r/running', TERMS, { minHits: 1 }), true);
  assert.equal(isRelevantRecord(text, 'r/running', TERMS, { minHits: 3 }), false);
});

/*
 * PHRASE MODE, measured 2026-08-22 on 207 real Hacker News records stored for a
 * "running shoes" report. Counting terms kept 100% at minHits 1 and 89% at
 * minHits 2, still passing threads about Aldi, Etsy, housing economics and the
 * Mac Pro. Requiring the phrase kept 54%, and those were genuinely about shoes.
 */
test('phrase mode rejects scattered subject words in an off topic comment', () => {
  const phrases = ['running shoes'];
  const scattered = 'You can just pay more money and get a higher quality house, same as running a business or buying shoes';
  assert.equal(
    isRelevantRecord(scattered, 'The anti-abundance critique on housing is wrong', [], { mode: 'phrase', phrases }),
    false,
    'both words appear, and the comment is about housing',
  );
});

test('phrase mode keeps a record that names the subject properly', () => {
  const phrases = ['running shoes'];
  assert.equal(
    isRelevantRecord(
      'Brooks Gravitas running shoes. More comfortable for my wide feet than my Hokas',
      'Ask HN: What are some great items you own?', [], { mode: 'phrase', phrases },
    ),
    true,
    'this is exactly the voice of customer we are looking for',
  );
});

test('phrase matching tolerates singular and plural on the last word only', () => {
  assert.equal(matchesSubjectPhrase('I bought a running shoe last week', ['running shoes']), true);
  assert.equal(matchesSubjectPhrase('these running shoes are narrow', ['running shoe']), true);
  assert.equal(matchesSubjectPhrase('runnings shoes', ['running shoes']), false, 'only the final word pluralises');
});

test('phrase matching requires adjacency, not co-occurrence', () => {
  assert.equal(matchesSubjectPhrase('running is fun and I need new shoes', ['running shoes']), false);
  assert.equal(matchesSubjectPhrase('shoes for running', ['running shoes']), false, 'word order matters');
});

test('a single word subject still works in phrase mode', () => {
  assert.equal(matchesSubjectPhrase('my headphones broke again', ['headphones']), true);
  assert.equal(matchesSubjectPhrase('my headphone broke again', ['headphones']), true);
  assert.equal(matchesSubjectPhrase('nothing relevant here', ['headphones']), false);
});

test('phrase mode falls back to term mode when no phrases are supplied', () => {
  const terms = subjectTerms(['running shoes']);
  assert.equal(isRelevantRecord('these shoes run narrow', 'r/running', terms, { mode: 'phrase', phrases: [] }), true);
});

test('the channel counts toward a phrase match, since a thread title carries the subject', () => {
  assert.equal(
    isRelevantRecord('Same, had to size up half a size', 'Best running shoes for wide feet?', [], {
      mode: 'phrase', phrases: ['running shoes'],
    }),
    true,
  );
});

/*
 * Regression, found live 2026-08-22 on the subject "wool runner".
 *
 * Subreddit discovery is a NAME PREFIX search, so it matched r/woolworths, an
 * Australian supermarket community. The record gate then scored
 * `text + ' ' + channel`, and prefix matching makes "wool" match "woolworths",
 * so the channel name alone cleared the gate on all 73 records harvested. The
 * report printed "sizing: 5 receipts [finding]" from comments about facemasks.
 */
test('a channel name cannot authorise its own records by prefix', () => {
  const terms = subjectTerms(['wool runner', 'wool runner']);
  assert.deepEqual(terms, ['wool', 'runner']);

  const offTopic = 'Store Manager just told me I am not allowed to wear a facemask anymore';
  assert.equal(
    isRelevantRecord(offTopic, 'woolworths', terms, { channelKind: 'handle' }), false,
    'woolworths carries wool but not runner, so it cannot vouch for its own records',
  );
});

test('a channel that genuinely names the subject still supports its records', () => {
  const terms = subjectTerms(['running shoes', 'running shoes']);
  /* "Same, had to size up" says nothing alone and everything in this thread. */
  assert.equal(
    isRelevantRecord('Same, had to size up', 'runningshoegeeks', terms, { channelKind: 'handle' }),
    true, 'it carries both running and shoe, so it is genuinely the right community',
  );
});

test('the text alone still carries a record when the channel says nothing', () => {
  const terms = subjectTerms(['wool runner', 'wool runner']);
  assert.equal(
    isRelevantRecord('these wool runners are great', 'australia', terms, { channelKind: 'handle' }),
    true,
  );
});

test('phrase mode gets the same channel treatment', () => {
  const terms = subjectTerms(['wool runner', 'wool runner']);
  assert.equal(
    isRelevantRecord('anyone know when the sale ends', 'woolworths', terms,
      { mode: 'phrase', phrases: ['wool runner'], channelKind: 'handle' }),
    false,
  );
});

test('a handle is scored as a substring, because it has no word boundaries', () => {
  const terms = subjectTerms(['running shoes', 'running shoes']);
  assert.equal(scoreHandle('runningshoegeeks', terms).hits, 2, 'shoes must find shoegeeks');
  assert.equal(scoreHandle('woolworths', subjectTerms(['wool runner', 'wool runner'])).hits, 1);
  assert.equal(scoreHandle('r/RunningShoeGeeks', terms).hits, 2, 'case and punctuation do not matter');
});

test('a single term subject needs only that one term in a handle', () => {
  const terms = subjectTerms(['skincare', 'skincare']);
  assert.deepEqual(terms, ['skincare']);
  assert.equal(isRelevantRecord('this stuff broke me out', 'skincareaddiction', terms, { channelKind: 'handle' }), true);
});

/*
 * Regression, measured live 2026-08-22. A "wool runner" report harvested
 * r/runninglifestyle, whose description happens to say "If you're a runner."
 * 383 of 412 records were rejected and 29 were stored on the strength of the
 * word "runner" alone. Of those 29, ONE mentioned wool, and the report stated
 * findings about wool runners from comments about Brooks Glycerin.
 */
test('a record from a community that did not vouch must carry the whole subject', () => {
  const terms = subjectTerms(['wool runner', 'wool runner']);

  const generic = 'Brooks Glycerin 23, plush but surprisingly stable, a flat foot runner review';
  assert.equal(
    isRelevantRecord(generic, 'runninglifestyle', terms, { channelKind: 'handle' }), false,
    'one word of a two word subject is not the subject',
  );

  const onTopic = 'the wool runners breathe better than any other trainer I own';
  assert.equal(isRelevantRecord(onTopic, 'runninglifestyle', terms, { channelKind: 'handle' }), true);
});

/*
 * The other half of the same deal. Inside a community that IS about the
 * subject, an elliptical comment is real voice of customer and must survive.
 */
test('a community that vouches still keeps its elliptical comments', () => {
  const terms = subjectTerms(['running shoes', 'running shoes']);
  assert.equal(
    isRelevantRecord('Same, had to size up', 'runningshoegeeks', terms, { channelKind: 'handle' }), true,
    'the handle carries both running and shoe, so the thread is the context',
  );
});

test('a single word subject still needs only its one word', () => {
  const terms = subjectTerms(['skincare', 'skincare']);
  assert.equal(isRelevantRecord('this broke me out badly', 'acne', terms, { channelKind: 'handle' }), false);
  assert.equal(isRelevantRecord('my skincare routine changed', 'acne', terms, { channelKind: 'handle' }), true);
});

/*
 * THE THREAD TOPIC GATE.
 *
 * Found on 2026-08-22 by printing quotes next to the counts for the first time.
 * A "running shoes" report cited, as evidence of problems with running shoes, a
 * comment about Weebly and the semantic web. As evidence about price, a comment
 * about Corning and EU antitrust. Every receipt resolved to a real person, so
 * the anti fabrication gate was satisfied and the report was still wrong.
 *
 * The cause: 131 of 150 Hacker News records sat in threads about something
 * else, and each contained the phrase once, so the phrase gate passed them all.
 */
const HN = (text: string, channel: string): boolean =>
  isRelevantRecord(text, channel, ['running', 'shoe'], { mode: 'phrase', phrases: ['running shoes'] });

test('a general forum thread about something else does not lend its comments to the subject', () => {
  const essay =
    'Moreover, the example of frame materials is instructive. In tests, cyclists cannot tell the '
    + 'difference between frame materials when the frame geometry is held constant, which suggests '
    + 'that a great deal of what we believe about equipment is marketing rather than engineering. '
    + 'The same is true of running shoes, and of most consumer goods where the buyer cannot easily '
    + 'run a controlled trial and has to fall back on brand reputation and price as a proxy.';

  assert.ok(essay.length > 400, 'the point of this fixture is that it is long');
  assert.equal(HN(essay, 'Wooden bikes'), false,
    'a thousand word aside mentioning the subject once is not market evidence');
});

test('a short comment that names the subject survives an off topic thread', () => {
  /* Focus, not repetition. This says it once and it is entirely about shoes. */
  assert.equal(
    HN('Brooks Gravitas running shoes. More comfortable for my wide feet than my Hokas',
      'Ask HN: What are some great items you own?'),
    true,
  );
});

test('an on topic thread lends its topic to comments that never name the subject', () => {
  /* The same rule a subreddit gets, because the container established the
   * subject. Requiring the record to repeat it dropped this case and broke the
   * main path when it was first attempted. */
  assert.equal(HN('Same, had to size up half a size', 'Best running shoes for wide feet?'), true);
  assert.equal(HN('These lasted me 400 miles', 'Nike Says Its $250 Running Shoes Will Make You Run Faster'), true);
});

test('the focus requirement scales with length rather than being a fixed count', () => {
  const short = 'running shoes are overpriced';
  const long = `${'Some unrelated argument about monetary policy. '.repeat(20)} running shoes are overpriced`;

  assert.equal(HN(short, 'Ask HN: what do you buy'), true);
  assert.equal(HN(long, 'Ask HN: what do you buy'), false,
    'the same sentence buried in an essay about something else is an aside');
});
