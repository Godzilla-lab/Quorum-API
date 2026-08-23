/*
 * `receipts verify`: check somebody's claims against the corpus.
 *
 * WHY THIS IS THE MOST IMPORTANT COMMAND IN THE TOOL.
 *
 * Every research API in 2026 returns text with citations attached, and a
 * calling agent has no way to check any of it. It cannot tell a real source
 * from a plausible one, and the failure is invisible: a fabricated citation
 * looks exactly like a real one, survives review, and is discovered by a
 * customer clicking a link that goes nowhere.
 *
 * That gate already exists inside this pipeline. It runs on our own synthesis
 * and it has never been reachable by anyone else, which is a strange place to
 * keep the one capability nobody else has.
 *
 * So this verb takes a report, ours or anybody's, and answers three questions
 * that can be answered with facts rather than judgement:
 *
 *   Does every cited id resolve to a real record?
 *   Does every quoted sentence appear in one of the records it cites?
 *   Does each claim still clear the corroboration bar once the ids that
 *   resolve to nothing have been removed?
 *
 * IT EXITS NON ZERO WHEN SOMETHING IS FABRICATED, because the point is to be
 * runnable in somebody else's CI against output we did not produce.
 */

import type { CorpusDriver } from '@receipts/corpus';
import { fabricationReport, resolveCitations, type FabricationReport, type ModelClaim } from '@receipts/core';

export interface VerifyInput {
  claims: ModelClaim[];
  /* Where the claims came from, for the report header. */
  label: string;
}

export interface VerifiedClaim {
  term: string;
  text: string;
  cited: number;
  resolved: number;
  fabricated: string[];
  unsupportedQuotes: string[];
  verdict: 'finding' | 'weak-signal' | 'rejected';
  /* Recomputed over the ids that actually resolved, never inherited. */
  records: number;
  demoted: boolean;
}

export interface VerifyResult {
  label: string;
  claims: VerifiedClaim[];
  report: FabricationReport;
  /* True when nothing was invented and nothing was misquoted. */
  clean: boolean;
}

/*
 * Reads either shape.
 *
 * Our own `--json` output nests claims under `claims[].receiptIds` and carries
 * no model text, because our claims are counts rather than sentences yet.
 * Anybody else's output is expected to name its claims and their ids. Both are
 * accepted, because refusing to check a competitor's output would defeat the
 * purpose of the command.
 */
export function readClaims(parsed: unknown): ModelClaim[] {
  const root = parsed as { claims?: unknown; findings?: unknown };
  const list = Array.isArray(root?.claims) ? root.claims
    : Array.isArray(root?.findings) ? root.findings
      : [];

  const out: ModelClaim[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue;

    const ids = entry['receiptIds'] ?? entry['receipts'] ?? entry['evidence_ids'] ?? entry['citations'];
    const receiptIds = Array.isArray(ids)
      ? ids.map((id) => (typeof id === 'string' ? id : (id as { receiptId?: string })?.receiptId ?? ''))
        .filter(Boolean)
      : [];

    const text = typeof entry['text'] === 'string' ? entry['text']
      : typeof entry['claim'] === 'string' ? entry['claim']
        : '';
    const term = typeof entry['term'] === 'string' ? entry['term'] : 'unnamed';

    /* A claim with no ids at all is still checked. It cannot be fabricated and
     * it also cannot be supported, and saying so is the honest answer. */
    out.push({ text, term, receiptIds });
  }
  return out;
}

export async function verifyClaims(input: VerifyInput, corpus: CorpusDriver): Promise<VerifyResult> {
  const resolved = await resolveCitations(input.claims, corpus);

  const claims: VerifiedClaim[] = resolved.map((claim, i) => {
    const cited = new Set(input.claims[i]?.receiptIds ?? []).size;
    return {
      term: claim.term,
      text: claim.text,
      cited,
      resolved: claim.receipts.length,
      fabricated: claim.fabricated,
      unsupportedQuotes: claim.unsupportedQuotes,
      verdict: claim.verdict,
      records: claim.corroboration.records,
      /*
       * Demoted means the claim only cleared the bar with the help of ids that
       * resolve to nothing. This is the number that matters: a fabricated
       * citation cannot contribute to a count under any circumstances.
       */
      demoted: claim.fabricated.length > 0 && claim.verdict !== 'finding',
    };
  });

  const report = fabricationReport(resolved);
  return { label: input.label, claims, report, clean: report.clean };
}

export function renderVerify(result: VerifyResult): string {
  const out: string[] = [];
  const r = result.report;

  out.push(`VERIFY    ${result.label}`);
  out.push('');
  out.push(`  ${r.claimsChecked} claims, ${r.idsCited} cited ids, ${r.quotesChecked} quoted passages`);
  out.push('');

  for (const claim of result.claims) {
    const head = claim.text ? claim.text.slice(0, 88) : `(${claim.term})`;
    out.push(`  ${claim.fabricated.length || claim.unsupportedQuotes.length ? 'FAIL' : ' ok '}  ${head}`);
    out.push(`          ${claim.resolved} of ${claim.cited} ids resolve, ${claim.records} distinct records, ${claim.verdict}`);
    for (const id of claim.fabricated.slice(0, 4)) {
      out.push(`          invented id, resolves to nothing: ${id}`);
    }
    for (const quote of claim.unsupportedQuotes.slice(0, 2)) {
      out.push(`          quoted, and appears in none of the cited records: "${quote.slice(0, 70)}"`);
    }
    if (claim.demoted) {
      out.push('          this claim only cleared the bar with ids that do not exist');
    }
  }

  out.push('');
  if (result.clean) {
    out.push(`  clean: every cited id resolves and every quote appears in a record it cited`);
  } else {
    out.push(`  ${r.idsFabricated} invented id${r.idsFabricated === 1 ? '' : 's'}, `
      + `${r.quotesUnsupported} unsupported quote${r.quotesUnsupported === 1 ? '' : 's'}, `
      + `${r.claimsRejected} claim${r.claimsRejected === 1 ? '' : 's'} rejected`);
    out.push('  A citation that resolves to nothing was not a mistake in formatting.');
  }

  return out.join('\n');
}
