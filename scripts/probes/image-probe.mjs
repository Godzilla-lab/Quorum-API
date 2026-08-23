import { fetchArchived } from '../../packages/sources/src/product/wayback.ts';
import { extractProductFacts } from '../../packages/sources/src/product/jsonld.ts';

for (const url of [
  'https://www.allbirds.com/products/mens-wool-runners',
  'https://gymshark.com/products/gymshark-arrival-t-shirt-black',
]) {
  const a = await fetchArchived(url, { timeoutMs: 25000 });
  if (!a) { console.log(new URL(url).host, '-> no snapshot\n'); continue; }
  const f = extractProductFacts(a.html);
  console.log(`${new URL(url).host}  snapshot ${a.snapshot.timestamp}`);
  console.log('  images found:', f?.images.length ?? 0);
  for (const img of (f?.images ?? []).slice(0, 3)) console.log('   ', img.slice(0, 118));
  // Does the original CDN still serve the image even though the HTML page blocked us?
  const first = f?.images?.[0];
  if (first) {
    const original = first.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\//i, '');
    try {
      const r = await fetch(original, { method: 'HEAD' });
      console.log(`  original cdn HEAD: ${r.status} ${r.headers.get('content-type') ?? ''}`);
    } catch (e) { console.log('  original cdn HEAD failed:', e.message); }
  }
  console.log('');
}
