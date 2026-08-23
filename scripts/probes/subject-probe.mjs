/* Does subject resolution hold up on real input, text and blocked stores alike? */
import { resolveSubject } from '../../packages/sources/src/product/subject.ts';

const inputs = process.argv.slice(2).length ? process.argv.slice(2) : [
  'running shoes',
  'project management software for agencies',
  'https://www.allbirds.com/products/mens-wool-runners',
  'https://gymshark.com/products/gymshark-arrival-t-shirt-black',
  'https://www.rei.com/product/193434/hoka-clifton-9-road-running-shoes-mens',
];

for (const input of inputs) {
  const s = await resolveSubject(input, { timeoutMs: 12000 });
  const label = input.length > 46 ? input.slice(0, 43) + '...' : input;
  console.log(`${label.padEnd(48)} ${s.source.padEnd(13)} category=${JSON.stringify(s.category)}`);
  if (s.brand) console.log(`${''.padEnd(48)} brand=${s.brand}${s.price ? `  price=${s.price}` : ''}`);
  if (s.note) console.log(`${''.padEnd(48)} note: ${s.note.slice(0, 60)}`);
}
