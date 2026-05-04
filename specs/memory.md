# Memory — Spec (Placeholder)

> **TBD.** The user has an existing memory-system design that will be imported into this file.
>
> Until then, this page is a stub so the nav entry has somewhere to land.

## Where this fits

The Memory layer is the **durable, agent-readable substrate** behind the rest of Mission Control:

- **Research** writes brief findings into memory; future briefs ground on them.
- **Decisions** writes ratified decisions into memory as durable facts.
- **Stakeholders & Comms** reads from memory when drafting updates so it doesn't re-derive context every time.
- **PM** uses memory to maintain working knowledge of the project across conversations.
- **Risks**, **Calendar**, **Initiatives** all become memory writers/readers.

In short: every other surface in this set is a *view* over Memory or a *producer* of Memory entries.

## Open questions (to be answered by imported spec)

- Storage shape (key-value, tagged docs, embedding-indexed chunks, hybrid?)
- Scope rules (workspace / global / per-agent)
- Write authority (who can write — humans, agents, both, with attribution)
- Decay / TTL
- Retrieval interface for agents (MCP tool? injected context? query DSL?)
- Conflict resolution when memories contradict
