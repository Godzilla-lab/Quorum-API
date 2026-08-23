# @quorum/mcp

An MCP server over the Quorum SDK.

Built. Five tools over stdio, spoken as JSON-RPC 2.0 with no dependency.

The design below was written before the code and the code follows it, because
the tool schema is the part that is expensive to change later.

## Connecting a client

**Claude Code** reads `.mcp.json` at the repo root, which is already there.
Start Claude Code from this directory and the tools appear.

**Claude Desktop** uses `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS). Absolute paths, because it
does not run from your repo:

```json
{
  "mcpServers": {
    "quorum": {
      "command": "node",
      "args": [
        "--disable-warning=ExperimentalWarning",
        "/absolute/path/to/Quorum-API/packages/mcp/src/bin.ts"
      ],
      "env": { "QUORUM_CORPUS": "/absolute/path/to/quorum.db" }
    }
  }
}
```

Anything else that speaks MCP over stdio works the same way: run
`packages/mcp/src/bin.ts` with `QUORUM_CORPUS` pointed at a corpus.

**It runs on your machine, against your corpus, and touches no network** unless
you set `QUORUM_MCP_RESEARCH=1`. Until you do, `research_product` is not even
registered and the retrieval stack is never imported, so there is no adapter
loaded that could reach out.

## Why this exists

Distribution, not revenue. Over 20,000 MCP servers are indexed across the public
registries and under 5% earn a dollar, with total agent to tool payment volume
under $50k per day globally. Servers listed on five or more directories see
roughly ten times the installs. So: ship it, list it widely, and price through
the API rather than through the protocol.

## Design constraints, from what the practice actually shows

Roughly 80% of MCP server quality is decided by the tool schema. A single tool
definition costs 100 to 500 tokens, and a bloated 58 tool setup burns about
55,000 tokens before the agent has done anything useful.

Three rules follow:

1. **Five tools, not one per endpoint.** Similar operations collapse into one
   tool with an action enum.
2. **Aggregate server side.** Return counts and top records, never a raw row
   dump. `search_evidence` answers "how many and which ones", it does not
   stream the corpus into a context window.
3. **Markdown output, not JSON.** Measured at roughly 60% of the token count for
   the same content.

## The tools

| Tool | Does | Notes |
|---|---|---|
| `research_product` | Start a report from a URL or a name | **Off unless QUORUM_MCP_RESEARCH=1** |
| `search_evidence` | Query the corpus directly, no synthesis | Aggregated counts plus top records |
| `get_receipt` | Resolve one or many receipt ids to real records | Batched |
| `category_warmth` | Coverage, and whether an ask is cheap or expensive | Lets an agent decide before spending |
| `compare_formats` | Video versus static verdict for a category | Pure arithmetic, no model call |

## The pitch no other research server can make

A calling agent can **independently verify every claim this server returns**,
because `get_receipt` resolves the ids that `research_product` cited. If an id
does not resolve, the claim was not real. That is the anti fabrication rule
paying off in the one place hallucination costs the most.
