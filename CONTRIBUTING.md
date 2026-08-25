# Contributing

The most useful thing you can add is a source. The interface exists so that
adding one touches only its own directory, and if you find yourself editing
anything outside it, that is a bug in our design and worth an issue.

## Adding a source

Create `packages/sources/src/<your-source>/` and implement:

```ts
export interface Source {
  readonly id: string;
  readonly cost: 'free' | 'metered';
  configured(env: Env): boolean;
  plan(input: PlanInput): Promise<Query[]>;
  retrieve(q: Query, ctx: Ctx): AsyncIterable<Record>;
  cite(r: Record): Citation;
}
```

Then run it through the shared conformance suite. If it passes that and ships
fixtures, it is most of the way to mergeable.

### The rules, and why they exist

- **Never authenticate to a scraped source.** No cookies, no logged in
  scraping, ever. This is not a style preference. The legal footing for all of
  this is logged off public data, and a credential forfeits it. A pull that
  authenticates to a scraped source will be closed regardless of how good it is.
  Metered vendor APIs where we hold an account are a different category.
- **A record must be somebody speaking, not a page somebody copied.** A scrape
  dump pasted into a forum post or an issue tracker is not a voice, however
  public its host, and harvesting it launders somebody else's scraping through
  ours. Found live: an entire scraped race site inside a GitHub issue, stored
  as running shoe evidence. The relevance gate's density rule enforces this;
  an adapter for a source where dumps are common should filter the shape at
  the adapter too, the way the GitHub adapter skips github.io repos.
- **Return empty rather than throwing when unconfigured.** A missing key must
  degrade a run, never fail it. Someone with no keys at all should still get a
  report.
- **Yield incrementally.** The corpus writes as you go, so a run that dies
  halfway still leaves the archive better than it found it.
- **Throttle yourself.** Several upstreams are free and volunteer run. Back off
  on their signals, and assume the limit is dynamic.
- **Fetch only through the guarded client.** Calling `fetch` directly is an SSRF
  hole, because the URLs come from users.
- **Charge the cost meter** on anything paid.

### Fixtures

Capture real responses while you are building, because that is the only cheap
moment to get them. The suite runs offline and in CI with no keys, which is only
possible if fixtures are real captures rather than hand written guesses.

Strip anything that is not needed. Public usernames are fine, since they are
part of the record. Anything else should not be there.

## Style

- Named exports only. No default exports.
- `camelCase` functions, `SCREAMING_SNAKE` module constants.
- **Comments explain why, and carry the date a number was measured.** This is
  the house habit that matters most. A measured constant without a date is a
  number nobody can ever safely change.
- **No em dashes or en dashes anywhere**, including comments and error strings.
  `npm run lint:copy` will catch you.
- Errors are values on the result, not thrown, anywhere a vendor can be down.

Node 22.18+ strips types natively, so imports name the real file on disk
(`./thing.ts`, not `./thing.js`) and `erasableSyntaxOnly` is on. If tsc rejects
an enum or a namespace, that is why.

## Before you open a pull request

```
npm run build && npm test && npm run lint:copy && npm run check:security
```

All four. The security pass reports PENDING for checks whose code does not exist
yet, and those are not passes.

If you touched synthesis, the anti fabrication suite is the one that matters.
"We cannot hallucinate a quote" has to stay a passing test, because it is the
entire pitch.
