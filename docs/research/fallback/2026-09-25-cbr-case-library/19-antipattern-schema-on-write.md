---
name: "Anti-pattern: schema-on-write forcing all fields on all record types over a schemaless store"
topic: "cbr-antipatterns"
tags: ["pattern:antipattern", "schema-on-read", "schema-on-write", "schemaless"]
summary: "Enforcing a full required schema at write time over a schemaless store trades ingestion speed and heterogeneity for structure you can enforce on read. For a CBR library with multiple case types, schema-on-write forces every case to carry every field, rejects partial cases, and turns evolution into a migration. Schema-on-READ with a typed validation layer is the fit here."
importance: 7
type: best-practice
data_quality: estimated
---

# content

name: Anti-pattern — schema-on-write over a schemaless store
description: Applying a strict schema to data before it is written, versus schema-on-read which stores raw (or loosely-typed) data and validates/interpretes it at read time. Over a store that deliberately has no schema enforcement, imposing schema-on-write fights the store.

why_it_fails:
  - Rejects/blockages at ingest: a case missing one required field cannot be written — but cases legitimately arrive incomplete (a problem without a verified outcome yet; a solution without a principle).
  - Kills heterogeneity: different case types (success case, failure/negative case, principle, meta-case) need different fields; a single required schema forces a union of all fields onto all types, most of them empty.
  - Migration tax: every schema change requires rewriting existing records; over an append-only/bitemporal store that is exactly the wrong leverage.
  - The store provides no enforcement anyway, so the "schema" is enforced only by convention at the write call sites — giving the cost without the guarantee.

what_to_do_instead:
  - Schema-on-READ: write cases loosely (topic/tags/metadata/summary are enough carriers), and validate/interpret against a typed record at read time, per case type.
  - Use a discriminator field (a case kind in metadata/topic) to select the read-time schema — the standard way to type heterogeneous records over a schemaless store.
  - Make required-ness depend on the record's lifecycle state, not on the type: an unverified case need not carry an outcome field; a *retrievable* case must pass the read-time validation (which subsumes the verified-outcome gate).
  - Keep migration cheap by versioning the record shape in a field and letting the read layer transcode old shapes.

strengths: (none — anti-pattern entry)
weaknesses:
  - Nuance: schema-on-read pushes correctness to read time, so every reader must validate; an unvalidated reader silently misinterprets. The mitigation is a single typed accessor layer, not per-call ad-hoc parsing. And "schema-on-read isn't free" — validity/completeness is not guaranteed at ingest, so queries must be defensive.

references:
  - General schema-on-read vs schema-on-write discussion (Google search 2026-09-25: multiple sources; schema-on-write "prioritizes structure, performance, reliability", schema-on-read "prioritizes flexibility and speed of ingestion").
  - Aamodt & Plaza case representation (the fields) is a READ contract, not a write requirement.
source:
  - General data-engineering literature (secondary)
data_quality: estimated
type: best-practice
tags:
  - pattern:antipattern
  - schema-on-read
  - schema-on-write
  - schemaless
summary: "Forcing a full schema at write time over a schemaless store rejects legitimately-incomplete cases, kills case-type heterogeneity, and taxes every evolution with a migration — while the store enforces nothing anyway. Use schema-on-read with a typed accessor and a discriminator; gate required fields on lifecycle state."
---

## Confidence
**MEDIUM** — the schema-on-read vs schema-on-write trade-off was only sourced from general
(data-engineering blog) search hits this run, not a single authoritative reference. The
CBR-specific argument (heterogeneous case types + lifecycle-gated requiredness) is **MEDIUM**
by reasoning from the representation entry.
