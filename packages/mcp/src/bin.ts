#!/usr/bin/env node
/*
 * The MCP server, on stdio.
 *
 *   QUORUM_CORPUS=./quorum.db npx quorum-mcp
 *
 * READ ONLY BY DEFAULT. `research_product` is only registered when
 * QUORUM_MCP_RESEARCH=1, because a report is minutes of throttled retrieval
 * against volunteer archives and an agent should not be able to start one by
 * accident. The other four answer from what is already held, cost nothing, and
 * touch no network.
 *
 * NOTHING MAY WRITE TO STDOUT EXCEPT THE PROTOCOL. Every diagnostic below goes
 * to stderr; one stray line on stdout corrupts the stream and the client
 * disconnects with a parse error that points here rather than at the culprit.
 */

import { openSqliteCorpus } from '@quorum/corpus';
import { createTools } from './tools.ts';
import { serveStdio } from './protocol.ts';

const corpusPath = process.env['QUORUM_CORPUS'] ?? './quorum.db';
const allowResearch = process.env['QUORUM_MCP_RESEARCH'] === '1';

const corpus = openSqliteCorpus({ path: corpusPath });

process.stderr.write(`quorum-mcp: corpus ${corpusPath}, ${allowResearch ? 'read write' : 'read only'}\n`);
if (!allowResearch) {
  process.stderr.write('quorum-mcp: research_product is off. Set QUORUM_MCP_RESEARCH=1 to allow reports.\n');
}

const tools = createTools({
  corpus,
  /*
   * Imported lazily and only when enabled, so a read only server never loads
   * the retrieval stack or the adapters that can reach the network.
   */
  ...(allowResearch
    ? {
      research: async (subject: string, terms: string[]): Promise<string> => {
        const { runResearch } = await import('@quorum/cli');
        const { makeSource, makeAdSource, resolveSubject, SOURCE_IDS } = await import('@quorum/sources');
        const { renderMarkdown } = await import('@quorum/cli');
        const result = await runResearch({
          subject,
          terms: terms.length ? terms : ['quality', 'problems', 'price'],
          communities: [],
          sources: [...SOURCE_IDS],
          adSources: [],
          corpusPath,
          maxQueriesPerSource: 6,
          maxRecordsTotal: 20_000,
          deadlineMs: 15 * 60_000,
          capUsd: 0,
          compare: [],
          offline: false,
          readImages: false,
          maxImages: 0,
          synthesise: false,
          synthesisModel: undefined,
          format: 'markdown',
          asOf: undefined,
          json: false,
          quiet: true,
        }, {
          openCorpus: (path) => openSqliteCorpus({ path }),
          resolveSubject,
          makeSource,
          makeAdSource,
          env: process.env,
        });
        return renderMarkdown(result);
      },
    }
    : {}),
});

process.stderr.write(`quorum-mcp: ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`);

await serveStdio(tools, { name: 'quorum', version: '0.0.0' });
await corpus.close();
