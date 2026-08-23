/*
 * What kind of creative is this ad.
 *
 * Returning null is load bearing. The format verdict counts only typed ads, so
 * an ad we cannot read must never be silently bucketed as a static: a ratio
 * computed over guesses is worse than no ratio at all.
 *
 * `displayFormat` IS NOT THE ANSWER, and believing it was is the single most
 * expensive bug in this module's history. Measured on a real pull of 30 ads,
 * 21 came back DCO and 2 came back DPA. Those are DELIVERY MODES, dynamic
 * creative and dynamic product ads, not creative types. Reading displayFormat
 * alone therefore threw away 23 of 30 ads, better than two thirds of the
 * sample, and the ratio computed from the remaining 7 was reported with a
 * straight face.
 *
 * The creative type actually lives in the media arrays: `snapshot.videos`,
 * `snapshot.images`, and for DCO and DPA the per variation `snapshot.cards`,
 * where each card carries either a video url or only an image.
 */

export type CreativeType = 'video' | 'static' | null;

/*
 * Vendor payloads arrive in both camelCase and snake_case, sometimes in the
 * same response, so every field is checked in both spellings.
 *
 * THE SPELLING LIST IS NOT DECORATIVE, AND A GAP IN IT SILENTLY DISCARDS ADS.
 *
 * Measured against a real 30 ad pull on 2026-08-22: of 90 cards, 3 carried an
 * image whose ONLY signal was `image_crops`, and this file checked `imageCrops`
 * in camelCase alone. Those cards were invisible, so an ad whose cards all look
 * like that types as null, leaves the sample, and takes its evidence with it.
 * `watermarked_resized_image_url` was not checked in either spelling.
 *
 * Every key below was observed in that capture. The full observed card key set
 * is: cta_text, cta_type, image_crops, link_description, link_url,
 * original_image_url, resized_image_url, video_hd_url, video_preview_image_url,
 * video_sd_url, watermarked_resized_image_url, watermarked_video_hd_url,
 * watermarked_video_sd_url.
 *
 * `video_preview_image_url` is deliberately NOT an image signal: it is the
 * poster frame of a video, so counting it would type every video ad as static.
 */
interface MediaLike {
  videoHdUrl?: unknown; videoSdUrl?: unknown;
  video_hd_url?: unknown; video_sd_url?: unknown;
  watermarkedVideoHdUrl?: unknown; watermarkedVideoSdUrl?: unknown;
  watermarked_video_hd_url?: unknown; watermarked_video_sd_url?: unknown;
  originalImageUrl?: unknown; resizedImageUrl?: unknown;
  original_image_url?: unknown; resized_image_url?: unknown;
  watermarkedResizedImageUrl?: unknown; watermarked_resized_image_url?: unknown;
  imageCrops?: unknown; image_crops?: unknown;
}

export function hasVideo(o: MediaLike | null | undefined): boolean {
  if (!o) return false;
  return Boolean(
    o.videoHdUrl ?? o.videoSdUrl ?? o.video_hd_url ?? o.video_sd_url ??
    o.watermarkedVideoHdUrl ?? o.watermarkedVideoSdUrl ??
    o.watermarked_video_hd_url ?? o.watermarked_video_sd_url,
  );
}

export function hasImage(o: MediaLike | null | undefined): boolean {
  if (!o) return false;
  return Boolean(
    o.originalImageUrl ?? o.resizedImageUrl ?? o.original_image_url ??
    o.resized_image_url ?? o.watermarkedResizedImageUrl ??
    o.watermarked_resized_image_url ?? o.imageCrops ?? o.image_crops,
  );
}

interface AdSnapshot {
  videos?: unknown;
  images?: unknown;
  cards?: unknown;
  displayFormat?: unknown;
  display_format?: unknown;
}

export interface RawAd {
  snapshot?: AdSnapshot;
  [key: string]: unknown;
}

export function creativeType(raw: RawAd): CreativeType {
  const snap = (raw.snapshot ?? raw) as AdSnapshot;
  const videos = Array.isArray(snap.videos) ? snap.videos : [];
  const images = Array.isArray(snap.images) ? snap.images : [];
  const cards = Array.isArray(snap.cards) ? (snap.cards as MediaLike[]) : [];

  /* Video wins a mixed card set: a carousel with any video in it is being run
   * as a video ad, and that is the decision an advertiser made. */
  if (videos.length || cards.some(hasVideo)) return 'video';
  if (images.length || cards.some(hasImage)) return 'static';

  /*
   * Last resort only, and only when displayFormat actually names a creative
   * type rather than a delivery mode. DCO, DPA and anything else unknown falls
   * through to null on purpose.
   */
  const df = String(snap.displayFormat ?? snap.display_format ?? '').toUpperCase();
  if (df === 'VIDEO') return 'video';
  if (df === 'IMAGE') return 'static';
  return null;
}
