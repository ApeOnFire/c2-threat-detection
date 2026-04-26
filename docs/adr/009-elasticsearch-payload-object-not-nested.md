---
id: ADR-009
status: Accepted
date: 2026-04-26
---

# ADR-009: Elasticsearch payload mapped as `object`, not `nested`

## Context

`DetectionEvent.payload` is an embedded object stored inside each Elasticsearch document. Elasticsearch offers two mapping types for embedded objects: `object` (the default) and `nested`. The choice affects how the payload fields are indexed and what query DSL is required to reach them.

`nested` is designed for arrays of objects where cross-field matching within a single array element is required — for example, finding documents where a specific tag has both `name: "env"` and `value: "prod"` on the same element. Without `nested`, Elasticsearch flattens array elements and the cross-field constraint is lost.

## Decision

`payload` is mapped as `object`. A `DetectionEvent` has exactly one payload — not an array. `object` mapping indexes payload fields as first-class document fields (`payload.peakCountRate`, `payload.isotope`, etc.), reachable via standard `term`, `range`, and `multi_match` queries with no additional DSL.

## Consequences

- Phase 6 query logic uses standard Elasticsearch query patterns throughout. No nested query DSL is required anywhere in the codebase.
- If the schema were ever changed so that a single event carries multiple payloads (an array), the mapping would need to change to `nested` and all existing queries would need to be rewritten. The current schema makes this scenario physically impossible — one event, one payload.
- New modality payload fields (XRAY_SCAN, CBRN_DETECTION) added to the mapping later are immediately queryable via the same standard query patterns.
