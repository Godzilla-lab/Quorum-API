# Security

## Reporting a vulnerability

Email the maintainer rather than opening a public issue. We will acknowledge
within a few days and give you a timeline once the impact is understood. Please
include what you did, what you expected, and what happened.

## What this project touches, and where the risk actually is

Receipts fetches public web content on behalf of callers and feeds it to a
language model. That shape has two sharp edges, and both get tests rather than
good intentions.

### Server side request forgery

The core API input is a **user supplied product URL that the server then
fetches**, and several adapters fetch further URLs discovered along the way.
Unguarded, `POST /v1/reports` with a URL pointing at link local space reads
cloud instance credentials.

Every outbound fetch goes through one guarded client, which:

- allows only the `http` and `https` schemes
- resolves DNS first and rejects private and reserved space before connecting:
  `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::1`,
  `fc00::/7`, `fe80::/10`
- pins the resolved address for the connection, which closes DNS rebinding
- revalidates every redirect hop against the same rules, and caps redirect depth
- caps response size and total time, so a slow or enormous response cannot pin a
  worker

An adapter that fetches without going through that client is a build failure,
not a review comment.

### Prompt injection

Retrieved comments are attacker controlled text. Anyone can post a Reddit
comment containing instructions and hope it reaches a model. The 2026 consensus
is blunt: this cannot be fully solved inside current architectures, and adaptive
attacks defeat essentially every published defence, so the only real posture is
defence in depth with deterministic policy enforced outside the model.

Receipts is unusually well placed here, because the product rule and the
security control are the same mechanism:

- **A claim needs corroboration from at least three independent records** before
  it is printed as a finding. One injected comment cannot clear that bar.
- **The model emits record ids, not prose that bypasses checking.** Ids are
  resolved against the real corpus at render time, and anything that does not
  resolve is dropped before it reaches output.
- Untrusted record text is structurally delimited from instructions in the
  prompt.

There is a test that feeds a corpus record carrying "ignore previous
instructions" through the pipeline and asserts it reaches neither findings nor
weaker signals.

## Data handling

- **We never authenticate to a scraped source.** No session cookies, no logged
  in scraping, ever. This is architectural, not a preference: the legal footing
  is logged off public data, and a cookie forfeits it.
- Retrieved records carry public usernames and permalinks. A record removed at
  source can be removed here: the corpus supports deletion by source and
  external id, and takedown requests are honoured.
- API keys are stored as hashes with a short display prefix, compared in
  constant time, and never logged whole.
- Corpus databases, environment files and generated reports are gitignored and
  must never be committed.

## Acceptable use

Certificate Transparency logs are used only to discover brands and products.
Using this project for infrastructure enumeration or attack surface mapping
against a third party is out of scope and unwelcome.
