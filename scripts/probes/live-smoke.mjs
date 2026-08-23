import { createHackerNewsSource, createArcticShiftSource, createArcticShiftClient } from '../../packages/sources/src/index.ts';

const ctx = { env: {}, cost: { charge: () => 0, canSpend: () => true }, log: (m) => console.log('   log:', m) };

console.log('=== HACKER NEWS, live, through the real adapter ===');
const hn = createHackerNewsSource();
const hnQueries = await hn.plan({ category: 'mechanical keyboards', productTitle: 'Keeb', productUrl: 'https://x.com', terms: ['switches'] });
let hnCount = 0, hnSample = null;
for await (const r of hn.retrieve(hnQueries[0], ctx)) { hnCount++; hnSample ??= r; }
console.log('   records:', hnCount);
if (hnSample) {
  console.log('   sample :', JSON.stringify(hnSample.text.slice(0, 110)));
  console.log('   entities decoded?', !/&#x|&quot;|&gt;|<p>/.test(hnSample.text));
  console.log('   url    :', hnSample.url);
  console.log('   cite   :', hn.cite(hnSample).label);
}

console.log('\n=== ARCTIC SHIFT, live, through the real adapter ===');
const as = createArcticShiftSource({ client: createArcticShiftClient() });
const asQueries = await as.plan({ category: 'running shoes', productTitle: 'Trail X', productUrl: 'https://x.com', terms: ['sizing'] });
console.log('   planned queries:', asQueries.length, '->', asQueries.slice(0, 5).map(q => `r/${q.scope}:${q.text}`).join(', '));

let asCount = 0, asSample = null, posts = 0, comments = 0;
for (const q of asQueries.slice(0, 2)) {
  for await (const r of as.retrieve(q, ctx)) {
    asCount++;
    if (r.kind === 'post') posts++; else comments++;
    asSample ??= r;
  }
}
console.log('   records:', asCount, `(${posts} posts, ${comments} comments)`);
if (asSample) {
  console.log('   sample :', JSON.stringify(asSample.text.slice(0, 110)));
  console.log('   cite   :', as.cite(asSample).label);
}
