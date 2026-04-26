---
id: ADR-006
status: Accepted
date: 2026-04-26
---

# ADR-006: First-matching-rule-wins evaluation with UUID-ordered seed rows

## Context

A single detection event could theoretically match multiple alarm rules (e.g. peakCountRate exceeds threshold AND an isotope is identified). The system must produce exactly one alarm record per event — multiple records for a single physical scan would misrepresent the event count in operator dashboards.

## Decision

Rule evaluation stops at the first matching rule. Rules are evaluated in ascending `id` order. Seed rows use explicit UUIDs with a `...0001` / `...0002` prefix to encode priority lexicographically, without adding a separate priority column.

## Consequences

- One alarm record per physical scan is a domain correctness requirement. Two alarm records for a single vehicle pass would misrepresent event counts and confuse operators. The `event_id UNIQUE` constraint in PostgreSQL enforces it at the storage layer (see ADR-002).
- Rule priority is implicit in seed UUID ordering. Operators adding rules via SQL must be aware that UUID order determines evaluation sequence — this is documented in the README.
