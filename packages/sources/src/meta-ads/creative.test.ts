import { test } from 'node:test';
import assert from 'node:assert/strict';

import { creativeType, hasImage, hasVideo } from './creative.ts';

/*
 * THE REGRESSION TABLE.
 *
 * Measured on a real 30 ad pull: 21 came back DCO and 2 came back DPA. Those
 * are delivery modes, not creative types, so reading displayFormat alone threw
 * away 23 of 30 ads and reported a ratio computed from the remaining 7.
 */
test('a DCO ad is typed from its cards, not from displayFormat', () => {
  const dco = {
    snapshot: {
      displayFormat: 'DCO',
      cards: [{ videoHdUrl: 'https://cdn/v.mp4' }, { originalImageUrl: 'https://cdn/i.jpg' }],
    },
  };
  assert.equal(creativeType(dco), 'video', 'displayFormat says DCO, which names nothing about the creative');
});

test('a DPA ad is typed from its cards too', () => {
  const dpa = { snapshot: { displayFormat: 'DPA', cards: [{ resizedImageUrl: 'https://cdn/i.jpg' }] } };
  assert.equal(creativeType(dpa), 'static');
});

test('the full delivery mode set falls through to the media arrays', () => {
  for (const mode of ['DCO', 'DPA', 'CAROUSEL', 'MULTI_IMAGES', 'AUTOMATED_APP_ADS', 'UNKNOWN', '']) {
    assert.equal(
      creativeType({ snapshot: { displayFormat: mode, videos: [{ videoHdUrl: 'x' }] } }),
      'video',
      `${mode} must not prevent typing from the media arrays`,
    );
  }
});

test('displayFormat is used only when it names an actual creative type', () => {
  assert.equal(creativeType({ snapshot: { displayFormat: 'VIDEO' } }), 'video');
  assert.equal(creativeType({ snapshot: { displayFormat: 'IMAGE' } }), 'static');
  assert.equal(creativeType({ snapshot: { display_format: 'video' } }), 'video', 'and it is case insensitive');
});

/*
 * The load bearing null. An ad we cannot read leaves the sample rather than
 * joining a bucket, because a ratio computed over guesses is worse than none.
 */
test('an unreadable ad returns null and is never bucketed', () => {
  assert.equal(creativeType({ snapshot: { displayFormat: 'DCO' } }), null, 'DCO with no media is simply unknown');
  assert.equal(creativeType({ snapshot: {} }), null);
  assert.equal(creativeType({}), null);
  assert.equal(creativeType({ snapshot: { cards: [] } }), null);
  assert.equal(creativeType({ snapshot: { cards: [{}] } }), null, 'a card with no media types nothing');
});

test('videos and images arrays type an ad directly', () => {
  assert.equal(creativeType({ snapshot: { videos: [{ videoSdUrl: 'x' }] } }), 'video');
  assert.equal(creativeType({ snapshot: { images: [{ originalImageUrl: 'x' }] } }), 'static');
});

test('video wins a mixed carousel, because that is the decision the advertiser made', () => {
  const mixed = { snapshot: { cards: [{ originalImageUrl: 'i' }, { videoHdUrl: 'v' }] } };
  assert.equal(creativeType(mixed), 'video');
});

test('an ad without a snapshot wrapper is still read', () => {
  assert.equal(creativeType({ videos: [{ videoHdUrl: 'x' }] } as never), 'video');
});

test('both field spellings are recognised, since one response can mix them', () => {
  assert.equal(hasVideo({ videoHdUrl: 'x' }), true);
  assert.equal(hasVideo({ video_hd_url: 'x' }), true);
  assert.equal(hasVideo({ watermarkedVideoSdUrl: 'x' }), true);
  assert.equal(hasImage({ originalImageUrl: 'x' }), true);
  assert.equal(hasImage({ original_image_url: 'x' }), true);
  assert.equal(hasImage({ imageCrops: {} }), true);
  assert.equal(hasVideo(null), false);
  assert.equal(hasImage(undefined), false);
  assert.equal(hasVideo({}), false);
});

/*
 * The measured pull, reconstructed. If this ever drops below 30 typed, the
 * displayFormat bug is back.
 */
test('the measured 30 ad pull types all 30, not 7', () => {
  const ads = [
    ...Array.from({ length: 21 }, () => ({ snapshot: { displayFormat: 'DCO', cards: [{ videoHdUrl: 'v' }] } })),
    ...Array.from({ length: 2 }, () => ({ snapshot: { displayFormat: 'DPA', cards: [{ originalImageUrl: 'i' }] } })),
    ...Array.from({ length: 5 }, () => ({ snapshot: { displayFormat: 'VIDEO', videos: [{ videoHdUrl: 'v' }] } })),
    ...Array.from({ length: 2 }, () => ({ snapshot: { displayFormat: 'IMAGE', images: [{ originalImageUrl: 'i' }] } })),
  ];

  const typed = ads.map(creativeType).filter((t) => t !== null);
  assert.equal(typed.length, 30, 'reading displayFormat alone would have typed only 7');
  assert.equal(typed.filter((t) => t === 'video').length, 26);
  assert.equal(typed.filter((t) => t === 'static').length, 4);
});
