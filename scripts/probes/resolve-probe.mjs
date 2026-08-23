/* Does the ladder recover pages that refuse a direct fetch? */
import { resolveProduct } from '../../packages/sources/src/product/resolve.ts';

const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.allbirds.com/products/mens-wool-runners',
  'https://gymshark.com/products/gymshark-arrival-t-shirt-black',
  'https://www.rei.com/product/193434/hoka-clifton-9-road-running-shoes-mens',
];

for (const url of urls) {
  const host = new URL(url).host;
  const r = await resolveProduct(url, { timeoutMs: 25000 });
  console.log(`${host}`);
  console.log(`  trail   : ${r.trail.map((t) => `${t.tier}${t.ok ? ' ok' : ' x'}`).join(' -> ')}`);
  if (r.error) { console.log(`  FAILED  : ${r.error}\n`); continue; }
  console.log(`  strategy: ${r.strategy}   category=${JSON.stringify(r.category)} (${r.categoryInferred ? 'inferred' : 'stated'})`);
  console.log(`  title   : ${JSON.stringify(r.title.slice(0, 58))}`);
  if (r.archivedAt) console.log(`  archived: ${r.archivedAt.toISOString().slice(0, 10)}  commercial facts stale: ${r.commercialFactsStale}`);
  console.log(`  brand   : ${r.brand ?? '(none)'}   price: ${r.price ?? '(withheld)'}   rating: ${r.ratingValue ?? '(withheld)'}`);
  if (r.reviews.length) console.log(`  reviews : ${r.reviews.length} in markup`);
  console.log(`  images  : ${r.images.length}`);
  for (const img of r.images.slice(0, 2)) console.log(`     ${img.slice(0, 96)}`);
  console.log('');
}
