/*
 * Video or static, decided as arithmetic rather than opinion.
 *
 * The raw split across all ads is the weak signal. The real one is the split
 * AMONG THE WINNERS, because duration is the proof of what an advertiser keeps
 * choosing to pay for. If 62% of all ads are static but 80% of the ads running
 * past 90 days are video, the answer is video, and the raw split is shown only
 * for contrast.
 *
 * Three rules keep it honest:
 *
 *   - Untyped ads are EXCLUDED, never bucketed. `creativeType` returns null
 *     when it cannot tell, and a ratio computed over guesses is worse than no
 *     ratio.
 *   - Undated ads are excluded from every duration cut. A duration that was
 *     inferred rather than reported or observed is not evidence.
 *   - Below the minimum sample there is NO verdict, and the report says so.
 *     "Not enough competitor evidence to call this" is a real answer and a
 *     more useful one than a number derived from nine ads.
 *
 * Scoped to one network deliberately. A video native library mixed in would
 * manufacture a video verdict out of nothing but where we happened to look.
 */

export type Creative = 'video' | 'static' | null;
export type DurationConfidence = 'reported' | 'observed' | 'none';

export interface VerdictAd {
  network?: string;
  creative: Creative;
  daysRunning: number | null;
  durationConfidence: DurationConfidence;
  platforms?: string[];
  /*
   * The ad this came from, so the verdict can name its own evidence. Optional
   * only because arithmetic tests construct ads without one; a real run always
   * carries it.
   */
  adId?: string;
  /* Who is paying for it. Optional for the same reason as adId; a real run
   * carries it, and the confidence rules below read it. */
  advertiser?: string;
}

export interface Share { video: number; static: number; total: number; videoShare: number | null }

export interface FormatVerdict {
  network: string;
  sample: {
    ads: number; typed: number; untyped: number; dated: number; past60: number; past90: number;
    /*
     * Distinct advertisers in the deciding cohort, and how its durations were
     * established. Added 2026-08-24 because both were invisible: one company
     * running thirty long lived video ads produced "video, strong" from a
     * single media buy, and a cohort whose durations were mostly our own
     * observation spans partly measures our polling cadence against a pool
     * Meta only keeps while ads are live. The confidence rules read both.
     */
    advertisers: number;
    basis: { reported: number; observed: number };
  };
  raw: Share;
  longRunners: Share & { cohortDays: number };
  durationWeighted: { videoDays: number; staticDays: number; videoShare: number | null };
  byPlatform: Record<string, Share>;
  verdict: 'video' | 'static' | 'both' | null;
  confidence: 'strong' | 'moderate' | 'thin' | null;
  reason: string;
  /*
   * THE ADS THAT DECIDED IT. Added 2026-08-22 after an audit found this was one
   * of only two places in the response stating a conclusion about the market
   * with nothing resolvable behind it.
   *
   * "Video wins, strong confidence" is exactly the kind of sentence this
   * product exists to make checkable, and it shipped as a bare verdict with
   * sample counts. These are the long runner cohort, the ads the verdict
   * actually rests on, so a caller can fetch them and disagree.
   */
  cohortAdIds: string[];
}

export interface FormatVerdictOptions {
  network?: string;
  /* Below this many typed ads there is no verdict at all. */
  minTyped?: number;
  /* And below this many long runners there is no verdict either. */
  minLong?: number;
  longDays?: number;
  midDays?: number;
}

function share(list: VerdictAd[]): Share {
  const video = list.filter((a) => a.creative === 'video').length;
  const still = list.filter((a) => a.creative === 'static').length;
  const total = video + still;
  return { video, static: still, total, videoShare: total ? video / total : null };
}

function platformSplit(typed: VerdictAd[]): Record<string, Share> {
  const byPlatform = new Map<string, VerdictAd[]>();
  for (const ad of typed) {
    for (const p of ad.platforms ?? []) {
      const bucket = byPlatform.get(p) ?? [];
      bucket.push(ad);
      byPlatform.set(p, bucket);
    }
  }
  const out: Record<string, Share> = {};
  for (const [p, ads] of byPlatform) out[p] = share(ads);
  return out;
}

export function formatVerdict(ads: VerdictAd[], options: FormatVerdictOptions = {}): FormatVerdict {
  const {
    network = 'meta',
    minTyped = 20,
    minLong = 8,
    longDays = 90,
    midDays = 60,
  } = options;

  const pool = ads.filter((a) => (a.network ?? 'meta') === network);
  const typed = pool.filter((a) => a.creative === 'video' || a.creative === 'static');
  /* An inferred duration is not evidence, so undated ads leave every duration cut. */
  const dated = typed.filter((a) => a.durationConfidence !== 'none' && a.daysRunning != null);

  const past60 = dated.filter((a) => (a.daysRunning ?? 0) >= midDays);
  const past90 = dated.filter((a) => (a.daysRunning ?? 0) >= longDays);

  /* Prefer the 90 day cohort. Drop to 60 only when 90 is too thin to read. */
  const cohortDays = past90.length >= minLong ? longDays : midDays;
  const cohort = cohortDays === longDays ? past90 : past60;

  /* Duration weighted: an ad running 200 days counts 200 times one running a day. */
  const weight = { video: 0, static: 0 };
  for (const a of dated) {
    if (a.creative === 'video') weight.video += a.daysRunning ?? 0;
    else if (a.creative === 'static') weight.static += a.daysRunning ?? 0;
  }
  const weightTotal = weight.video + weight.static;

  const cohortAdvertisers = new Set(
    cohort.map((a) => a.advertiser?.trim()).filter((name): name is string => Boolean(name)),
  );
  const basis = {
    reported: cohort.filter((a) => a.durationConfidence === 'reported').length,
    observed: cohort.filter((a) => a.durationConfidence === 'observed').length,
  };

  const out: FormatVerdict = {
    network,
    sample: {
      ads: pool.length,
      typed: typed.length,
      untyped: pool.length - typed.length,
      dated: dated.length,
      past60: past60.length,
      past90: past90.length,
      advertisers: cohortAdvertisers.size,
      basis,
    },
    raw: share(typed),
    longRunners: { ...share(cohort), cohortDays },
    durationWeighted: {
      videoDays: weight.video,
      staticDays: weight.static,
      videoShare: weightTotal ? weight.video / weightTotal : null,
    },
    byPlatform: platformSplit(typed),
    verdict: null,
    confidence: null,
    reason: '',
    /* The cohort, not the whole pool: these are the ads the verdict rests on. */
    cohortAdIds: cohort.map((a) => a.adId).filter((id): id is string => Boolean(id)),
  };

  if (typed.length < minTyped || past60.length < minLong) {
    out.reason =
      `not enough competitor evidence to call a format: ${typed.length} ads with a known creative type ` +
      `(need ${minTyped}) and ${past60.length} running past ${midDays} days (need ${minLong})`;
    return out;
  }

  /*
   * UNTYPED ADS LEAVING SILENTLY WAS THE ORIGINAL SIN OF THIS MODULE: reading
   * `displayFormat` threw away 23 of 30 real ads and the ratio over the
   * survivors was reported with a straight face. Excluding untypeable ads is
   * still right, and above this share the survivors stop being a sample of
   * the pool: if the network shifts to a creative shape the media keys do not
   * cover, the ratio silently becomes a ratio of the leftovers. 0.4 is a
   * guardrail chosen 2026-08-24, not a measured constant; the honest failure
   * is a named refusal either way.
   */
  const untypedShare = pool.length ? out.sample.untyped / pool.length : 0;
  if (untypedShare > 0.4) {
    out.reason =
      `${out.sample.untyped} of ${pool.length} ads here have no readable creative type, ` +
      'so a ratio over the rest would describe the readable minority rather than the market';
    return out;
  }

  const s = out.longRunners.videoShare;
  if (s === null) {
    out.reason = 'no long running ads with a known creative type';
    return out;
  }

  /*
   * The dead band between 35% and 65% is a real answer, not a failure to
   * decide. A category where both formats sustain is a category where the
   * creative matters more than the format.
   */
  out.verdict = s >= 0.65 ? 'video' : s <= 0.35 ? 'static' : 'both';

  /*
   * Confidence is how hard the evidence leans, how much of it there is, and
   * WHOSE conviction it represents.
   *
   * A single advertiser running thirty long lived video ads used to produce
   * "video, strong": one company's media buy presented as a market pattern.
   * And a cohort whose durations are mostly observation spans is partly a
   * measurement of our own polling cadence, because spans only accrue when a
   * category is re-run, on ads the network only keeps while they are live.
   * Neither degrades the verdict itself, the arithmetic is what it is; both
   * cap how confidently it is stated. A cohort with NO advertiser names at
   * all is unknown rather than singular, so it is not punished: arithmetic
   * callers construct ads without them.
   */
  const margin = Math.abs(s - 0.5) * 2;
  const advertiserBreadth = cohortAdvertisers.size === 0 ? null : cohortAdvertisers.size;
  const selfObservedMajority = basis.observed > basis.reported;
  if (
    typed.length >= 40 && out.longRunners.total >= 15 && margin >= 0.3
    && (advertiserBreadth === null || advertiserBreadth >= 3)
    && !selfObservedMajority
  ) out.confidence = 'strong';
  else if (out.longRunners.total >= minLong && margin >= 0.15 && advertiserBreadth !== 1) out.confidence = 'moderate';
  else out.confidence = 'thin';

  const pct = Math.round(s * 100);
  out.reason =
    `of the ${out.longRunners.total} ads running ${cohortDays}+ days here, ` +
    `${out.longRunners.video} are video and ${out.longRunners.static} are static (${pct}% video)`;
  return out;
}
