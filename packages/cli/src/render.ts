/*
 * Rendering.
 *
 * Pure: a RunResult in, a string out. No clock, no filesystem, no colour codes,
 * because a report that is going to be piped into a file or a diff should look
 * the same as one on a terminal.
 *
 * THE RENDERER DOES NOT DECIDE ANYTHING. The corroboration verdict arrives
 * already computed, and this file only chooses how to show it. A renderer that
 * counts for itself is a renderer that can disagree with the API for the same
 * evidence, which is the one inconsistency this product cannot afford.
 *
 * No em dashes or en dashes, here or anywhere. `npm run lint:copy` enforces it.
 */

import { isNotable, notableTrends } from '@quorum/core';
import type { Corroboration, SourceOutcome } from '@quorum/core';
import type { ScoreKind } from '@quorum/corpus/tiers';
import type { RunResult } from './run.ts';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const pad = (value: string | number, width: number): string => String(value).padEnd(width);
const padStart = (value: string | number, width: number): string => String(value).padStart(width);

/*
 * Pads to a column and ALWAYS leaves at least one space.
 *
 * MEASURED 2026-08-22 on a live run: the cost table used a 24 wide column and
 * printed "nvidia/nemotron-nano-9b-v2:free1,957 in / 963 out", because the
 * model id is 31 characters and padEnd does nothing once a value is already
 * over the width. Same class of defect as the retrieval table printing
 * "eu-safety-gateok". A fixed width column is a minimum, never a maximum.
 */
const column = (value: string | number, width: number): string => {
  const text = String(value);
  return text.length >= width ? `${text} ` : text.padEnd(width);
};

/* Model written sentences are the only variable length prose in this report,
 * and an unwrapped one destroys a fixed width layout the rest of it relies on. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length > width) { lines.push(line); line = word; continue; }
    line += ` ${word}`;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/*
 * The verdict is a binary and stays one: printable as a market statement, or
 * not. Zero records is on the not side, but calling it a weak signal reads as
 * "we found something faint" when we found nothing at all, so the empty case
 * gets a truer word here. The machine readable verdict is unchanged, which is
 * the point: this is wording, not a third state for a caller to handle.
 */
/*
 * A number means something different in every source, so it is never printed
 * bare. "2 points" under a two star review inverts what the person said, and
 * "0 points" under a federal recall reads as nobody agreeing with it.
 */
function scoreLabel(e: { score: number; scoreKind: ScoreKind }): string {
  if (e.scoreKind === 'none') return '';
  if (e.scoreKind === 'stars') return `, ${e.score} of 5 stars`;
  return e.score ? `, ${e.score} points` : '';
}

function label(claim: Corroboration): string {
  if (claim.verdict !== 'finding') return claim.records === 0 ? 'no evidence' : 'weak signal';
  /* Which route earned it, so the report shows its working rather than
   * asserting a verdict a reader has to take on trust. */
  switch (claim.basis) {
    case 'cross-tier': return 'finding, corroborated across tiers';
    case 'attested': return 'finding, two attested records';
    default: return 'finding';
  }
}

/*
 * Printed only when something other than voice evidence is present. On a run
 * where every source is a forum this adds a column of zeroes and says nothing,
 * and a report should not make a reader parse noise.
 */
function tierSpread(claims: readonly Corroboration[]): boolean {
  return claims.some((c) => c.tiers.A > 0 || c.tiers.B > 0 || c.tiers.D > 0);
}

/* One outcome row, shared by the record leg and the ads leg so the two can
 * never drift into printing the same information differently. */
function outcomeLine(o: SourceOutcome, seenWord: string, wroteWord: string, width = 16): string {
  return (
    `  ${pad(o.sourceId, Math.max(width, o.sourceId.length + 2))}${pad(o.status, 10)}` +
    `${padStart(o.recordsSeen, 6)} ${pad(seenWord, 9)}` +
    `${padStart(o.recordsWritten, 6)} ${pad(wroteWord, 9)}${padStart(seconds(o.elapsedMs), 8)}`
  );
}

function spread(claim: Corroboration): string {
  if (!claim.sources.length) return 'no records';
  return claim.sources
    .map((s) => `${s.source} ${s.records} rec / ${s.channels} ch`)
    .join(',  ');
}

export function renderText(result: RunResult): string {
  const out: string[] = [];

  out.push(`RECEIPTS  ${result.category}`);
  out.push('');

  /* A cached subject is stated, because a price read a week ago is not a price
   * read now, and a reader deciding on it should know which they have. */
  out.push(
    `SUBJECT   ${JSON.stringify(result.subject.title)} via ${result.subject.source}` +
    `${result.subjectCached ? ', from cache, not re-fetched' : ''}`,
  );
  const facts: string[] = [];
  if (result.subject.brand) facts.push(result.subject.brand);
  /* Never a bare number. An unnamed currency reads as dollars to whoever is
   * looking, so a price we cannot label says that instead of implying one. */
  if (result.subject.price !== undefined) {
    facts.push(result.subject.currency
      ? `${result.subject.price} ${result.subject.currency}`
      : `price ${result.subject.price}, currency not reported`);
  }
  if (result.subject.ratingValue !== undefined) {
    facts.push(`rated ${result.subject.ratingValue}${result.subject.ratingCount ? ` from ${result.subject.ratingCount}` : ''}`);
  }
  if (result.subject.images.length) facts.push(`${result.subject.images.length} image${result.subject.images.length === 1 ? '' : 's'}`);
  if (facts.length) out.push(`          ${facts.join(', ')}`);
  /* A URL we could not read is information, not an error, and it is why some
   * commercial facts are missing further down. */
  if (result.subject.note) out.push(`          note: ${result.subject.note}`);
  /*
   * When a bare name did not resolve on its own, the corpus was asked who makes
   * it. Showing the candidates is not decoration: it is how a reader checks that
   * we attached the price to the right product rather than a plausible one.
   */
  /*
   * A hint is shown because it changed where we looked, and a reader deciding
   * whether to trust a thin report needs to know a model chose the search
   * terms. It is labelled as a guess, because that is what it is.
   */
  if (result.hints) {
    const h = result.hints;
    const parts = [h.category ?? 'no category', ...(h.brands.length ? [`brands ${h.brands.join(', ')}`] : [])];
    out.push(`          guessed by ${h.model}: ${parts.join('; ')}`);
    out.push('          a guess about where to look, never about what is true');
  }
  if (result.brandsNamed.length) {
    /*
     * Called candidates rather than brands, and said to be a guess, because it
     * is one. This printed "brands the market named: Google, American, China"
     * for a running shoes report until 2026-08-22, in the confident voice the
     * rest of the report uses for corroborated findings.
     *
     * The receipt id travels with each one, so a reader can fetch the record
     * and see the heuristic misfire rather than take our word for it.
     */
    out.push('          capitalised words the records repeat, which may or may not be brands:');
    for (const b of result.brandsNamed.slice(0, 5)) {
      const first = b.receiptIds[0] ? `   ${b.receiptIds[0]}` : '';
      out.push(`            ${pad(b.name, 16)} ${b.records} rec / ${b.channels} ch${first}`);
    }
  }
  out.push('');

  if (result.retrieval) {
    const r = result.retrieval;
    /*
     * Measured from the ids present, not fixed. A hard coded 12 ran
     * "eu-safety-gate" straight into its own status and printed
     * "eu-safety-gateok". The evidence table already sizes its columns this
     * way; this line was the one place still guessing.
     */
    const sourceWidth = Math.max(12, ...r.outcomes.map((o) => o.sourceId.length + 2));
    out.push(`RETRIEVAL ${seconds(r.elapsedMs)}, ${r.totalSeen} seen, ${r.totalWritten} stored`);
    for (const o of r.outcomes) {
      out.push(
        `  ${pad(o.sourceId, sourceWidth)}${pad(o.status, 10)}` +
        `${padStart(o.recordsSeen, 6)} seen ${padStart(o.recordsGated, 6)} off topic ` +
        `${padStart(o.recordsWritten, 6)} stored ${padStart(seconds(o.elapsedMs), 8)}`,
      );
      if (o.reason) out.push(`  ${pad('', 12)}reason: ${o.reason}`);
    }
    /*
     * Degradation is printed every time, never summarised away. A report that
     * looks complete while a leg crashed is the failure worth engineering
     * against, and it is worse than a report that admits the gap.
     */
    if (r.degraded.length) {
      out.push('');
      out.push('  missing from this report:');
      for (const d of r.degraded) out.push(`    ${d.source}: ${d.reason}, so ${d.impact}`);
    }
    if (r.stoppedEarly) out.push(`  stopped early: ${r.stoppedEarly}`);
  } else {
    out.push('RETRIEVAL skipped, answering from the corpus alone. Zero upstream requests.');
  }
  out.push('');

  /*
   * The ads block. Printed even when the leg did not run, because "no
   * competitor ad evidence" is a hole a reader must be told about rather than
   * left to infer from a missing heading.
   */
  if (result.adRetrieval) {
    const a = result.adRetrieval;
    out.push(`ADS       ${seconds(a.elapsedMs)}, ${a.totalObserved} observed`);
    for (const o of a.outcomes) out.push(outcomeLine(o, 'observed', 'recorded'));
    for (const d of a.degraded) out.push(`  missing: ${d.source}: ${d.reason}, so ${d.impact}`);
    if (a.stoppedEarly) out.push(`  stopped early: ${a.stoppedEarly}`);
    out.push('');
  }

  if (result.formats) {
    const f = result.formats;
    out.push(`FORMAT    ${f.verdict ? `${f.verdict}, ${f.confidence} confidence` : 'no verdict'}`);
    out.push(`          ${f.reason}`);
    out.push(
      `          sample: ${f.sample.ads} ads, ${f.sample.typed} typed, ` +
      `${f.sample.untyped} untyped and excluded, ${f.sample.dated} with an evidenced date`,
    );
    /*
     * The moat, made visible. `observation-span` durations exist only because
     * something was recording on the day, and Meta destroys the underlying ad
     * when it stops. Nobody can reconstruct that column later at any price.
     */
    const b = result.durationBasis;
    out.push(
      `          duration from: ${b.reported} reported by the advertiser, ` +
      `${b.startDate} from a start date, ${b.observationSpan} from our own repeat sightings, ` +
      `${b.none} with no evidenced date`,
    );
    if (b.observationSpan > 0) {
      out.push('          The repeat sighting durations exist only because we recorded them.');
      out.push('          Meta deletes an inactive commercial ad, so they cannot be recovered later.');
    }
    out.push('');
  } else if (result.adRetrieval) {
    out.push('FORMAT    no ads held for this category, so no format verdict');
    out.push('');
  }

  const w = result.warmth;
  out.push(
    `CORPUS    ${w.docs} records, ${w.comments} comments, ${w.channels} channels, ` +
    `${w.warm ? 'warm' : 'cold'}${w.ageDays === null ? '' : `, last harvested ${w.ageDays.toFixed(1)}d ago`}`,
  );
  out.push('');

  const threshold = result.claims[0]?.threshold;
  /*
   * SAID BEFORE THE NUMBERS, NOT AFTER THEM.
   *
   * Every count below is as the market stood at a date in the past, and a
   * reader who meets that fact underneath the table has already read the table
   * as current. This is the one line that stops a historical report being
   * mistaken for a live one.
   */
  if (result.asOf) {
    out.push(`AS OF     ${result.asOf}. Every number below is the market as it stood at the end of that month.`);
    out.push('          Filtered on when each record was written, so it includes evidence we');
    out.push('          harvested later. Records with no usable date are in none of it.');
    out.push('');
  }

  out.push(`EVIDENCE  a claim needs ${threshold ?? 'N'} independent receipts to be stated as a finding`);
  if (result.voice.some((v) => v.categoryRecords > 0)) {
    out.push(`          the percentage is share of all ${result.warmth.docs} records held for this category`);
  }
  const termWidth = Math.max(8, ...result.claims.map((c) => c.term.length));
  /* Measured from the data rather than guessed. A fixed column silently
   * collided with the verdict on the first live run that carried two sources. */
  const spreadWidth = Math.max(12, ...result.claims.map((c) => spread(c).length)) + 2;
  const showTiers = tierSpread(result.claims);
  for (const claim of result.claims) {
    const tiers = showTiers
      ? `A${claim.tiers.A} B${claim.tiers.B} C${claim.tiers.C} D${claim.tiers.D}   `
      : '';
    /*
     * SHARE OF VOICE, BECAUSE A COUNT WITHOUT A DENOMINATOR IS NOT A PRIORITY.
     *
     * "15 receipts" is unreadable on its own: fifteen out of two hundred is a
     * footnote and fifteen out of forty is the thing to fix first. The report
     * has held both numbers since the first run and printed only one of them.
     */
    const share = result.voice.find((v) => v.term === claim.term);
    const shareLabel = share && share.categoryRecords > 0
      ? padStart(`${share.sharePct.toFixed(1)}%`, 6)
      : padStart('', 6);

    out.push(
      `  ${pad(claim.term, termWidth)} ${padStart(claim.records, 5)} receipts / ` +
      `${padStart(claim.channels, 3)} channels ${shareLabel}  ${tiers}${pad(spread(claim), spreadWidth)}` +
      `[${label(claim)}]`,
    );

    /*
     * THE QUOTES. Printed under the count they belong to, because a count with
     * no quotes is a census and this product is supposed to be research.
     *
     * Until 2026-08-22 this renderer printed the numbers and nothing else, so a
     * report about what a market says contained not one word that anybody in
     * that market had said. Reading our own output is what found it.
     *
     * The excerpt is never dash stripped. A quote that has been tidied is no
     * longer a quote, and every number above rests on these being exactly what
     * the person wrote.
     */
    for (const e of claim.evidence) {
      out.push(`      "${e.excerpt}"`);
      out.push(`         ${e.source} ${e.channel}${scoreLabel(e)}   ${e.receiptId}`);
    }
    if (claim.evidence.length) {
      if (claim.concentration.singleChannelDominant) {
        /* Said plainly rather than buried, because a claim can be true and
         * concentrated at the same time and only the reader can weigh that. */
        out.push(
          `         note: ${Math.round(claim.concentration.largestChannelShare * 100)}% of these receipts`
          + ` come from ${claim.concentration.largestChannel}`,
        );
      }
      out.push('');
    }
  }
  if (showTiers) {
    out.push('');
    out.push('  A attested, a named party stated it on the record. B transactional, an');
    out.push('  observable state. C voice, what people said. D context, which sets the');
    out.push('  scene and never promotes a claim on its own.');
  }
  /*
   * A channel means something different in each source, and a reader cannot
   * know that from a number. Summing them and printing "58 channels" invites
   * reading 58 communities, which would overstate independence, so the unit is
   * spelled out wherever the count appears.
   */
  if (result.claims.some((c) => c.channels > 0)) {
    out.push('');
    out.push('  A channel is a distinct place inside one source: a subreddit on Reddit, a');
    out.push('  story thread on Hacker News. Two sources are more independent than two');
    out.push('  channels of the same source.');
  }
  if (result.claims.some((c) => c.verdict === 'weak-signal' && c.records > 0)) {
    out.push('');
    out.push('  A weak signal is real evidence that has not been corroborated enough to');
    out.push('  state as a market pattern. It is shown so it can be chased, and it is never');
    out.push('  printed as a finding.');
  }
  out.push('');

  /*
   * Printed whenever the run did not answer the question, and never hidden
   * behind an empty table. A reader must be able to tell whether nobody
   * discusses this product, or we looked in the wrong place, or we found plenty
   * and rejected all of it, because only one of those is the market's fault.
   */
  const suf = result.sufficiency;
  if (suf.verdict !== 'sufficient') {
    out.push(`${suf.verdict === 'thin' ? 'THIN' : 'NO ANSWER'}  ${suf.reason}`);
    out.push(`          looked at ${suf.seen}, rejected ${suf.rejected} as off topic, stored ${suf.stored}`);
    for (const s of suf.suggestions) out.push(`          - ${s}`);
    out.push('');
  }

  /*
   * ATTESTED RECORDS, ABOVE THE VOICE EVIDENCE AND NOT MIXED INTO IT.
   *
   * Placed first because it outranks everything below it. A forum comment is
   * one person's impression; a recall is a named company telling a regulator,
   * with consequences for lying, that its product hurts people. Printing the
   * two in one list at equal weight would be the single most misleading thing
   * this renderer could do.
   */
  if (result.attested) {
    const a = result.attested;
    const verdict = a.corroboration.verdict === 'finding' ? 'finding' : 'weak signal';
    out.push(`ATTESTED  ${a.records} record${a.records === 1 ? '' : 's'} from ${a.parties} named part${a.parties === 1 ? 'y' : 'ies'}   [${verdict}]`);
    out.push('  A named party stated this to a regulator, on the record, with consequences');
    out.push('  for lying. Two of these are a finding on their own.');
    out.push('');
    for (const e of a.evidence) {
      out.push(`      "${e.excerpt}"`);
      out.push(`         ${e.source} ${e.channel}   ${e.receiptId}`);
    }
    out.push('');
  }

  /*
   * PRINTED IN ITS OWN BLOCK, AFTER THE EVIDENCE, AND LABELLED.
   *
   * The temptation is to fold a transcription in beside the quotes, because it
   * reads well there. That would be the single most damaging thing this
   * renderer could do: a reader who cannot tell a counted record from a
   * generated sentence has lost the only property the product sells. So it sits
   * apart, it says what it is, and it says what it is not.
   */
  if (result.readings.length) {
    const models = [...new Set(result.readings.map((r) => r.model))].join(', ');
    out.push(`IMAGES    ${result.readings.length} read by ${models}`);
    out.push('  Interpretations, not receipts. Nothing here is counted in any number above,');
    out.push('  and no claim cites it. The image is the receipt: open it and disagree.');
    out.push('');
    for (const reading of result.readings) {
      out.push(`  ${reading.imageUrl}`);
      const body = reading.text.replace(/\s+/g, ' ').trim();
      out.push(`    ${reading.kind}: ${body.length > 300 ? `${body.slice(0, 300)}...` : body}`);
    }
    out.push('');
  }

  /*
   * WHAT CHANGED, AND IT GOES NEAR THE TOP BECAUSE IT IS WHY SOMEBODY RAN THIS
   * A SECOND TIME.
   *
   * Everything below is the state of the market. This is the delta, and for a
   * reader who has seen the report before it is the only part that is news.
   * Printed only when something actually moved: a block that says "nothing
   * changed" on most runs teaches people to skip it, and the same rule decides
   * whether a webhook fires, so there is one answer rather than two.
   */
  if (result.diff && isNotable(result.diff)) {
    const d = result.diff;
    const when = d.ageDays >= 1 ? `${d.ageDays.toFixed(1)} days ago` : 'earlier today';
    out.push(`CHANGED   since the last report for this category, ${when}`);
    if (d.corpusGrowth > 0) {
      out.push(`          ${d.corpusGrowth} more records held now`);
    }
    out.push('');

    for (const change of d.claims) {
      if (change.before === null) {
        /* Not a change in the market. Saying so stops a new question reading
         * as a new problem. */
        if (change.after.verdict === 'finding') {
          out.push(`  ${pad(change.term, 12)}asked for the first time, ${change.after.records} records`);
        }
        continue;
      }
      if (change.promoted) {
        out.push(
          `  ${pad(change.term, 12)}NOW A FINDING   ${change.before.records} records then, `
          + `${change.after.records} now, so it crossed the threshold`,
        );
      } else if (change.demoted) {
        /* Records only ever get added, so this means a takedown removed one or
         * the bar moved. Both are worth being told about immediately. */
        out.push(
          `  ${pad(change.term, 12)}NO LONGER A FINDING   ${change.before.records} records then, `
          + `${change.after.records} now`,
        );
      } else if (change.recordsAdded > 0) {
        out.push(`  ${pad(change.term, 12)}+${change.recordsAdded} records   ${change.after.records} total, still ${change.after.verdict}`);
      } else {
        continue;
      }
      /* NAMED, not counted. A reader has to be able to fetch the thing that is
       * new and read it, or the diff is a number with nothing behind it. */
      if (change.newReceiptIds.length) {
        for (const id of change.newReceiptIds.slice(0, 3)) out.push(`                new: ${id}`);
        if (change.newReceiptIds.length > 3) {
          out.push(`                and ${change.newReceiptIds.length - 3} more new receipts`);
        }
      } else if (!change.receiptsExact && change.recordsAdded > 0) {
        /* Said out loud rather than presenting a count as though the ids were
         * known. A partial list of new ids reads as a complete one. */
        out.push('                too many receipts to name which are new, so this is a count');
      }
    }

    if (d.attestedAdded > 0) {
      out.push('');
      out.push(`  ${d.attestedAdded} new attested record${d.attestedAdded === 1 ? '' : 's'}, which outranks everything else here`);
    }
    for (const t of d.trendChanges) {
      out.push(`  ${pad(t.term, 12)}trend went from ${t.before} to ${t.after}`);
    }
    if (d.newThemes.length) {
      out.push(`  new topics: ${d.newThemes.join(', ')}`);
    }
    out.push('');
  }

  /*
   * VERSUS WHAT.
   *
   * EVERY LINE HERE IS A SHARE, AND THE COUNTS ARE PRINTED ONLY AS WORKING.
   * Fourteen complaints against six is a statement about how hard we looked in
   * each place, and a reader shown two counts side by side will compare them
   * whatever the caption says. So the share leads and the count follows it in
   * the same line, where it reads as the arithmetic rather than the answer.
   *
   * A term we cannot call prints the reason instead of a blank, because a
   * reader who sees nothing assumes we found nothing.
   */
  if (result.comparison) {
    const c = result.comparison;
    out.push(`VERSUS    ${c.baseline} against ${c.terms[0]?.sides.length ? c.terms[0].sides.length - 1 : 0} rival${c.terms[0]?.sides.length === 2 ? '' : 's'}`);
    out.push('          each retrieved as a corpus of its own, so no number here is co-occurrence');
    out.push('');

    for (const term of c.terms) {
      out.push(`  ${pad(term.term, 12)}${term.louder ? `LOUDER FOR ${term.louder}` : 'no call'}`);
      for (const side of term.sides) {
        const share = side.corpusRecords ? `${side.sharePct.toFixed(1)}%` : 'n/a';
        const working = side.verdict === 'no-records'
          ? 'no records held'
          : `${side.records} of ${side.corpusRecords} records, ${side.channels} channels, ${side.verdict}`;
        out.push(`              ${pad(side.subject, 20)}${pad(share, 8)}${working}`);
        /* One id per side, so a reader can fetch the thing being compared back
         * rather than taking the percentage on trust. */
        if (side.sampleReceiptIds[0]) {
          out.push(`              ${pad('', 20)}${pad('', 8)}e.g. ${side.sampleReceiptIds[0]}`);
        }
      }
      out.push(`              ${term.reason}`);
      out.push('');
    }

    if (c.thinSides.length) {
      out.push('  too little held to compare at all:');
      for (const t of c.thinSides) {
        out.push(`    ${pad(t.subject, 20)}${t.corpusRecords} records. Run it again to warm it.`);
      }
      out.push('');
    }
    if (c.unavailable.length) {
      /* Named rather than dropped. A side missing in silence looks exactly like
       * a side that had nothing to say. */
      out.push('  asked for and not retrieved:');
      for (const u of c.unavailable) out.push(`    ${pad(u.subject, 20)}${u.reason}`);
      out.push('');
    }
  }

  /*
   * WHAT THE MARKET RAISED THAT NOBODY ASKED ABOUT.
   *
   * PRINTED AS TOPICS, NEVER AS FINDINGS, AND THE WORDING IS THE WHOLE POINT.
   *
   * These clear the corroboration threshold as counts, so it would be easy to
   * print them next to the claims above. That would be a lie of framing: a
   * claim says "buyers report this runs small" and a topic says "this phrase
   * recurs across three communities". Only one of them is a statement about the
   * product, and a reader who cannot tell them apart has been misled by us
   * rather than by a model.
   *
   * The extraction is a phrase counter and it is published as one, with the
   * receipts attached, exactly like the brand candidates. A reader who thinks
   * "big deal" is not a topic can fetch the three records and see that.
   */
  if (result.themes.length) {
    out.push(`TOPICS    ${result.themes.length} phrases the corpus keeps returning to, that nobody asked about`);
    out.push('  Counted phrases, not claims about the product. Each one is what people');
    out.push('  wrote, in enough different places that it is not one voice repeating.');
    out.push('');
    for (const theme of result.themes) {
      out.push(
        `  ${pad(theme.phrase, 22)}${padStart(theme.records, 4)} records / `
        + `${padStart(theme.channels, 2)} channels   ${theme.receiptIds.slice(0, 2).join(' ')}`,
      );
    }
    out.push('');
    out.push('  Ask about one of these directly with --terms to get it counted, quoted and');
    out.push('  trended like any other question.');
    out.push('');
  }

  /*
   * TREND, AND IT IS THE BLOCK NOBODY ELSE CAN PRINT.
   *
   * Every competitor holds a live index and answers about now. This is the only
   * question a retained corpus can answer and a search cannot, so it gets a
   * heading rather than a column.
   *
   * SHARE OF CONVERSATION, NEVER RECORD COUNTS. Measured 2026-08-22: counting
   * records per month reported all five terms tested as rising, because
   * retrieval returns far more recent records than old ones. It was measuring
   * our harvesting. Three of the five verdicts changed once normalised.
   *
   * Only a change is printed. Five lines saying "unchanged" teach a reader to
   * skip the block, and steady is still on the json for anyone who wants it.
   */
  const notable = notableTrends(result.trends);
  if (notable.length) {
    const window = notable[0]!;
    out.push(`TRENDS    ${window.recent.from} to ${window.recent.to}, against ${window.prior.from} to ${window.prior.to}`);
    out.push('  Share of what was said in each period, not how many records we hold. Our');
    out.push('  harvest is heavier on recent months, so raw counts rise for everything.');
    out.push('');
    for (const trend of notable) {
      const label = { rising: 'rising ', fading: 'fading ', new: 'NEW    ' }[
        trend.direction as 'rising' | 'fading' | 'new'
      ];
      const move = trend.direction === 'new'
        ? padStart('', 8)
        : padStart(`${trend.deltaPp >= 0 ? '+' : ''}${trend.deltaPp.toFixed(1)}pp`, 8);
      out.push(`  ${pad(trend.term, 12)}${label}${move}   ${trend.reason}`);
    }
    /* The floor a move had to clear, so a reader can see how close it was
     * rather than taking the word on trust. */
    const floors = notable.filter((t) => t.noisePp > 0);
    if (floors.length) {
      out.push('');
      out.push(`  A move counts only above twice its own standard error, which here was ${floors[0]!.noisePp.toFixed(1)}pp.`);
      out.push('  Anything smaller is printed as steady, because this much evidence cannot');
      out.push('  tell it apart from chance.');
    }
    const undated = result.trends.reduce((n, t) => Math.max(n, t.undated), 0);
    if (undated) {
      out.push(`  ${undated} record${undated === 1 ? '' : 's'} carried no usable date and are in no period above.`);
    }
    out.push('');
  } else if (result.trends.some((t) => t.direction === 'unknown')) {
    /* Said out loud rather than left as an empty space, because "we cannot tell
     * yet" and "nothing changed" are different answers and only one of them
     * is fixed by running again later. */
    const why = result.trends.find((t) => t.direction === 'unknown')!;
    out.push('TRENDS    not enough dated history yet to compare periods');
    out.push(`  ${why.reason}. Run this again in a month and it will have two windows.`);
    out.push('');
  }

  /*
   * WHAT A MODEL WROTE, IN ITS OWN BLOCK, LABELLED, AND AFTER THE ARITHMETIC.
   *
   * Everything above this line is computed from the corpus and is true whether
   * or not a model ran. These are sentences somebody's model wrote. They print
   * only because every id under them was fetched back out of the corpus first,
   * and the check that did it is printed underneath rather than assumed.
   *
   * A reader who cannot tell a counted record from a generated sentence has
   * lost the only property this product sells, so the two never share a block.
   */
  if (result.synthesis) {
    const syn = result.synthesis;
    out.push(`WRITTEN   ${syn.model ?? 'no model answered'}, from ${syn.evidence.records} record${syn.evidence.records === 1 ? '' : 's'}`);
    out.push('  Sentences a model wrote. Every id beneath them was fetched back out of the');
    out.push('  corpus before this printed, and none of the counts above came from here.');
    out.push('');

    if (syn.error) {
      out.push(`  the model did not answer: ${syn.error}`);
      out.push('  Nothing else in this report depends on it.');
      out.push('');
    }

    for (const claim of syn.claims) {
      const verdict = claim.verdict === 'finding'
        ? 'finding    '
        : claim.verdict === 'rejected' ? 'REJECTED   ' : 'weak signal';
      out.push(`  [${verdict}] ${claim.term}`);
      for (const line of wrap(claim.text, 72)) out.push(`      ${line}`);
      out.push(`      ${claim.corroboration.records} receipt${claim.corroboration.records === 1 ? '' : 's'} / ${claim.corroboration.channels} channel${claim.corroboration.channels === 1 ? '' : 's'}   ${claim.receipts.slice(0, 4).map((r) => r.receiptId).join(' ')}${claim.receipts.length > 4 ? ` and ${claim.receipts.length - 4} more` : ''}`);
      /* Named rather than counted, because a reader has to be able to see
       * exactly which id went nowhere. */
      for (const id of claim.fabricated) out.push(`      INVENTED: ${id} resolves to no record`);
      for (const quote of claim.unsupportedQuotes) {
        out.push(`      NOBODY SAID: "${quote.length > 60 ? `${quote.slice(0, 60)}...` : quote}"`);
      }
      out.push('');
    }

    /*
     * WHY THE TWO COUNTS FOR ONE TERM CAN DISAGREE, SAID OUT LOUD.
     *
     * Found by reading a live report on 2026-08-22: EVIDENCE showed
     * "durability 1 receipt, weak signal" and WRITTEN showed "durability
     * 3 receipts, finding", with no explanation, which reads as the report
     * contradicting itself. It is not. The count above is a term search, and
     * a record saying "they wore through after four months" never contains the
     * word durability. The count here is over records a model judged relevant
     * after reading them, recomputed by the same gate on the same threshold.
     *
     * Printed only when they actually differ, because a paragraph explaining a
     * discrepancy that is not on the page is noise.
     */
    const disagreements = syn.claims
      .filter((c) => {
        /* A term with no arithmetic claim above is not a disagreement, it is a
         * term nothing was counted for, and explaining a discrepancy against a
         * number that is not on the page would be worse than saying nothing. */
        const counted = result.claims.find((d) => d.term === c.term);
        return counted !== undefined && counted.verdict !== c.verdict;
      })
      .map((c) => c.term);
    if (disagreements.length) {
      out.push(`  ${disagreements.join(', ')} read differently above, and neither number is wrong.`);
      out.push('  The count above is a term search, so a record saying "wore through after four');
      out.push('  months" never matches the word durability. The count here is over records a');
      out.push('  model judged relevant after reading them, and the same gate recomputed it on');
      out.push('  the same threshold over receipts that resolve.');
      out.push('');
    }

    for (const d of syn.discarded) out.push(`  discarded, ${d.reason}: ${d.detail}`);
    if (syn.discarded.length) out.push('');

    const f = syn.fabrication;
    out.push(`  checked: ${f.claimsChecked} claim${f.claimsChecked === 1 ? '' : 's'}, ${f.idsCited} id${f.idsCited === 1 ? '' : 's'} cited, ${f.idsFabricated} invented, ${f.quotesChecked} quote${f.quotesChecked === 1 ? '' : 's'} checked, ${f.quotesUnsupported} unsupported`);
    if (!f.clean) {
      out.push('  The model invented something. It was caught here and none of it was');
      out.push('  printed as a finding. This is the check working, not the check failing.');
    }
    out.push('');
  }

  /*
   * THE GAP BLOCK, and it is the thing no competitor can print.
   *
   * Every other product in this space holds one kind of evidence. Holding both
   * is what makes the disagreement visible, so it gets its own heading rather
   * than being folded into a claim line where it would read as a footnote.
   */
  if (result.gaps.length || result.silence) {
    out.push('GAPS      where the record and the market disagree');
    for (const gap of result.gaps) {
      const label = {
        'voice-without-attestation': 'buyers only ',
        'attestation-without-voice': 'record only ',
        'corroborated-across-tiers': 'both        ',
        thin: 'thin        ',
      }[gap.divergence];
      out.push(`  ${pad(gap.term, 12)}${label}  ${gap.reason}`);
    }
    if (result.silence) {
      out.push('');
      out.push(`  ${result.silence.reason}`);
      out.push(`  searched: ${result.silence.searched.join(', ')}`);
      out.push('  A clean record is a result. It is not the same as not having looked.');
    }
    out.push('');
  }

  const rc = result.receiptCheck;
  out.push(`RECEIPTS  ${rc.cited} cited, ${rc.resolved} resolved back to real records`);
  if (rc.unresolved.length) {
    out.push(`  FAILED: ${rc.unresolved.length} cited receipt${rc.unresolved.length === 1 ? '' : 's'} did not resolve.`);
    out.push('  Nothing above can be trusted. This is the failure the product exists to prevent.');
    for (const id of rc.unresolved.slice(0, 5)) out.push(`    ${id}`);
  }
  out.push('');

  out.push(`COST      $${result.cost.totalUsd.toFixed(4)} in ${seconds(result.elapsedMs)}`);
  for (const line of result.cost.lines) {
    const detail = line.kind === 'llm'
      ? `${line.inputTokens.toLocaleString()} in / ${line.outputTokens.toLocaleString()} out`
      : `${line.calls} call${line.calls === 1 ? '' : 's'}`;
    out.push(`  ${line.verified ? ' ' : '?'} ${column(line.key, 24)}${column(detail, 28)}$${line.usd.toFixed(4)}`);
  }
  /* An unverified rate is an estimate and must never be used to price a report,
   * so it is flagged at the point of reading rather than in a footnote. */
  if (result.cost.hasUnverified) {
    out.push('  ? = rate not confirmed with the vendor. Treat that line as an estimate.');
  }
  if (result.cost.overCap) out.push('  ! spend cap reached, the run stopped spending');

  return out.join('\n');
}

/*
 * Machine readable output.
 *
 * Shaped by hand rather than by serialising RunResult, so that adding a field
 * internally cannot silently change a contract someone is parsing.
 */
export function renderJson(result: RunResult): string {
  return JSON.stringify({
    category: result.category,
    subject: {
      title: result.subject.title,
      source: result.subject.source,
      url: result.subject.url ?? null,
      brand: result.subject.brand ?? null,
      price: result.subject.price ?? null,
      currency: result.subject.currency ?? null,
      images: result.subject.images,
      note: result.subject.note ?? null,
      cached: result.subjectCached,
      brandsNamed: result.brandsNamed,
      hints: result.hints,
    },
    ads: result.adRetrieval
      ? {
        elapsedMs: result.adRetrieval.elapsedMs,
        observed: result.adRetrieval.totalObserved,
        outcomes: result.adRetrieval.outcomes,
        degraded: result.adRetrieval.degraded,
      }
      : null,
    formats: result.formats,
    durationBasis: result.durationBasis,
    offline: result.offline,
    retrieval: result.retrieval
      ? {
        elapsedMs: result.retrieval.elapsedMs,
        totalSeen: result.retrieval.totalSeen,
        totalWritten: result.retrieval.totalWritten,
        stoppedEarly: result.retrieval.stoppedEarly,
        outcomes: result.retrieval.outcomes,
        degraded: result.retrieval.degraded,
      }
      : null,
    corpus: {
      records: result.warmth.docs,
      comments: result.warmth.comments,
      channels: result.warmth.channels,
      warm: result.warmth.warm,
      ageDays: result.warmth.ageDays,
    },
    claims: result.claims.map((c) => ({
      term: c.term,
      records: c.records,
      channels: c.channels,
      sources: c.sources,
      tiers: c.tiers,
      basis: c.basis,
      verdict: c.verdict,
      threshold: c.threshold,
      /*
       * A readable sample, added 2026-08-22 after reading our own output: a real
       * response carried 183 receipt ids and not one word anybody had written,
       * so an application could not render anything without 183 more requests.
       */
      evidence: c.evidence,
      /* Whether that evidence is spread out or coming from one place. */
      concentration: c.concentration,
      /* Still the evidence of record. The sample is what to read; this is what
       * to check, and every id here resolves through /v1/evidence. */
      receiptIds: c.receiptIds,
    })),
    /*
     * A sibling of `claims`, never a member of it. Every entry carries
     * `derived: true` and no receipt id, so a consumer that merges the two
     * arrays has to do it deliberately rather than by accident.
     */
    /*
     * Separate from `claims` on purpose. These answer no question that was
     * asked; their existence is the finding.
     */
    attested: result.attested,
    /*
     * A SIBLING OF `claims`, NEVER A MEMBER OF IT.
     *
     * `claims` are arithmetic over the corpus. These are sentences a model
     * wrote, and they carry the fabrication check that let them through, so a
     * consumer can see the check ran rather than trusting that it did.
     */
    synthesis: result.synthesis
      ? {
        model: result.synthesis.model,
        error: result.synthesis.error ?? null,
        evidence: result.synthesis.evidence,
        discarded: result.synthesis.discarded,
        fabrication: result.synthesis.fabrication,
        claims: result.synthesis.claims.map((c) => ({
          term: c.term,
          text: c.text,
          verdict: c.verdict,
          /* Only ids that resolved. A consumer can fetch every one of these
           * back through /v1/evidence and get the record it cites. */
          receiptIds: c.receipts.map((r) => r.receiptId),
          records: c.corroboration.records,
          channels: c.corroboration.channels,
          basis: c.corroboration.basis,
          /* Named, not counted. A caller checking us has to see which id. */
          fabricated: c.fabricated,
          unsupportedQuotes: c.unsupportedQuotes,
        })),
      }
      : null,
    /*
     * Whether each question is getting louder, as a share of what was said in
     * each period. Every direction is here including `steady` and `unknown`,
     * unlike the text report, which prints only what changed.
     */
    trends: result.trends,
    /* The month this answers as of, or null for now. A consumer must never
     * mistake a historical answer for a current one. */
    asOf: result.asOf,
    /* The denominator a raw count is missing. */
    voice: result.voice,
    /*
     * A SIBLING OF `claims`, NEVER A MEMBER OF IT. A claim answers a question
     * somebody asked; a theme is a phrase that recurs. Both carry receipts and
     * only one is a statement about the product.
     */
    themes: result.themes,
    /*
     * The delta against the last report for this category, or null on a first
     * run. A consumer polling this is watching for change rather than state,
     * and `newReceiptIds` names what to read.
     */
    diff: result.diff,
    /*
     * Versus what, or null unless --compare was passed. Every side is its own
     * corpus, `louder` is null wherever we decline to call it, and `reason`
     * always says why. A consumer reading only `sides` and ranking on
     * `sharePct` would be reproducing the call we refused to make.
     */
    comparison: result.comparison,
    /* Where attested and voice evidence disagree, and what nobody attested to. */
    gaps: result.gaps,
    silence: result.silence,
    readings: result.readings,
    sufficiency: result.sufficiency,
    receiptCheck: result.receiptCheck,
    cost: result.cost,
    elapsedMs: result.elapsedMs,
  }, null, 2);
}
