# @receipts/mcp

An MCP server over the Receipts SDK.

Not built yet. This file is the design, recorded now so the tool surface is
decided before anyone writes it, because the tool schema is the part that is
expensive to change later.

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
| `research_product` | Start a report from a URL, optionally wait | Action enum rather than separate start and poll tools |
| `search_evidence` | Query the corpus directly, no synthesis | Aggregated counts plus top records |
| `get_receipt` | Resolve one or many receipt ids to real records | Batched |
| `category_warmth` | Coverage, and whether an ask is cheap or expensive | Lets an agent decide before spending |
| `compare_formats` | Video versus static verdict for a category | Pure arithmetic, no model call |

## The pitch no other research server can make

A calling agent can **independently verify every claim this server returns**,
because `get_receipt` resolves the ids that `research_product` cited. If an id
does not resolve, the claim was not real. That is the anti fabrication rule
paying off in the one place hallucination costs the most.
