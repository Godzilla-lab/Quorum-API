# Meta Ad Library fixtures

`ad-library-search.json` was **captured from the live vendor**, never authored.

    actor    curious_coder/facebook-ads-library-scraper (build 2.7.21)
    query    facebook.com/ads/library q="running shoes" country=US
             active_status=all, ad_type=all, media_type=all
    pulled   30 ads, 1.05MB, 23s, on 2026-08-22
    cost     0.0228 USD for the 30

Fixtures in this repo are captured rather than written by hand, because of one
specific failure. The Hacker News adapter once filtered comments on `points >= 2`,
matched **zero of 6,903** available comments in production, and passed its tests
throughout, because the hand written fixture invented a field the API does not
return.

## What is in the file

Eight whole records, selected one per branch so the table covers every path
through `creativeType` and both sides of the end date calibration:

| branch | ad |
|---|---|
| video via `snapshot.videos` | 769587644217491 |
| static via `snapshot.images` | 866569929827744 |
| DPA typed by cards | 2065910923987657 |
| DCO typed by cards | 1339489931715040 |
| CAROUSEL typed by cards | 1559172095049007 |
| untyped, must stay null | 3732023676936285 |
| inactive, real end date | 1302302924806831 |
| active, end date is the read timestamp | 914467831604972 |

## What was removed, and what was not

Field values are byte for byte as captured. Nothing was edited.

These top level and `snapshot` keys were **dropped** so the file stays legible,
and the adapter provably reads none of them: `transparency_by_location`,
`aaa_info`, `advertiser`, `regional_regulation_data`, `fev_info`,
`verified_voice_context`, `impressions_with_index`, `reach_estimate`,
`menu_items`, `ec_certificates`, `root_reshared_post`, `extra_texts`,
`extra_links`, `snapshot.page_profile_picture_url`.

So this is **not** the full payload. If a future change needs one of those
fields, recapture rather than adding it by hand.

## What the capture measured

- **19 of 30 ads were active, and all 19 reported `end_date` equal to the day of
  the pull.** The other 11 were inactive and carried real end dates. A perfect
  19/11 correlation, replicating the 2026-08-13 measurement exactly.
- `total_active_time` was **absent on 30 of 30**, so there is no reported
  duration field in this payload at all.
- `display_format` could not type **17 of 30** (14 DPA, 1 DCO, 1 CAROUSEL, 1
  null). The media arrays typed 16 of those 17.
- Of 90 cards, **3 carried an image whose only signal was `image_crops`**, which
  `hasImage` was not checking. That was a real bug, found by this capture.
- A keyword search for "running shoes" returned ads from "Cholesterol Relief
  Community" and "Arthritis Support Community". No text threshold separates
  those from Clarks Shoes, which is why advertiser scoped retrieval is the real
  instrument.
