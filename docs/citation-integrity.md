# Citation integrity: measured, not promised

Every research tool says its citations are trustworthy. This page is about the
difference between saying that and proving it, with numbers on both sides.

## The measured state of AI citations

These are third party measurements, each linked so you can check them the same
way this product asks to be checked.

- The Tow Center for Digital Journalism tested eight AI search engines with
  200 direct quotes from real articles and asked each to cite the source. The
  tools returned incorrect citations **more than 60% of the time**, ranging
  from 37% wrong for the best performer to 94% for the worst, and most
  preferred a confident wrong answer over declining.
  ([Columbia Journalism Review, March 2025](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php))
- A 2026 study of commercial deep research agents measured citation accuracy
  between **78% and 94%**: between 6 and 22 of every 100 references produced
  by the tools people use for serious research do not check out.
  ([arXiv:2604.03173](https://arxiv.org/html/2604.03173v1))
- The failure is compounding downstream. Fabricated references in published
  academic papers rose from 1 in 2,828 papers in 2023 to 1 in 458 in 2025,
  and to 1 in 277 in early 2026.
  ([STAT, May 2026](https://www.statnews.com/2026/05/07/lancet-study-finds-steep-rise-fraudulent-citations-academic-papers/))

The cause is structural. In most systems a citation is generated text: the
model writes something that looks like a reference next to something that
looks like a claim, and nothing between generation and display checks that the
reference exists, let alone that it says what the claim says.

## What structural integrity looks like

Quorum makes fabricated citations impossible by construction rather than
unlikely by prompting. The design has four parts, all open source.

**1. Ids are minted from content, never by a model.** A receipt id is a hash
of the stored record's source and external id. The only way an id exists is
that the record it names was actually harvested and stored.

**2. Synthesis never touches ids.** The model that writes findings refers to
evidence by ordinal position in the evidence list it was shown. Ordinals are
mapped back to receipt ids by code. A model cannot fabricate an id because it
is never asked to produce one.

**3. Rendering resolves every id or drops the claim.** Before anything
prints, every cited id is resolved against the corpus. An id that does not
resolve takes its claim down with it. This is enforced at render time,
independently of what any prompt said.

**4. You can re-run the check yourself.** `GET /v1/evidence/{id}` returns the
record behind any id, and `POST /v1/verify` re-resolves a whole set of claims,
ours or anyone's. A claim whose ids do not resolve was never real.

None of this is asserted in a README and left there. The anti fabrication
suite feeds synthesis responses citing invented ids and asserts nothing
reaches the report, and it runs in CI on every commit.

## The live incident that proved it

On 2026-08-24 the hosted instance ran synthesis on a free model that turned
out to be a prolific fabricator. Asked to cite its evidence, it invented
**927 of the 1,363 ids it produced**.

Not one reached the report. The resolution gate dropped every invented id,
the surviving claims rested on the 344 real ones, and the report's receipt
check line read `344 cited, 344 resolved, 0 unresolved`. A later run on the
same day read `231 cited, 231 resolved`.

That is the difference in one sentence: the model fabricated 68% of its
citations and the product shipped 0% of them, because the check is code in
the path, not a request in the prompt.

## What this does not claim

Honesty about the boundary is part of the pitch. Resolvability proves a cited
record exists and says what the quote says. It does not by itself prove the
record fully supports the sentence above it: a real quote can still be weak
support for a strong claim. Quorum narrows that gap with a corroboration
threshold (a finding needs at least three independent records, enforced at
render time) and treats entailment scoring as an evals problem it is still
building, not a solved one.

## Check it now

```bash
# any receipt id from any Quorum answer resolves to the human who said it
curl https://quorum-api-j15n.onrender.com/v1/evidence/rc_8f2a1c... \
  -H "authorization: Bearer YOUR_KEY"
```

The engine, the gates and the tests are all in this repository under
Apache 2.0. The claim is not that our model is more honest. It is that our
model is not trusted.
