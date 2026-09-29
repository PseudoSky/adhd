---
name: "Schema-on-read — store raw, interpret against a schema at read time (lakehouse table formats)"
topic: "content-type-parameterization"
tags: ["pattern:recommended", "schema-on-read", "schema-evolution", "typed-output", "storage-design", "prior-art"]
summary: "Schema-on-read stores records as-is and applies a schema only on read; lakehouse table formats (Delta Lake, Apache Iceberg) add typed metadata, schema ENFORCEMENT, and schema evolution as opt-in policy on top of raw storage. This is the storage half of L3 profile-typed output: tag each finding with its profile + profile-specific fields and validate per-profile on read — never force a global write-time schema."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 8
type: best-practice
data_quality: estimated
---

# content

name: Schema-on-read with opt-in enforcement (schema evolution as policy)
description: Schema-on-read defers interpretation: the payload is stored raw and a schema is applied only when read. Modern lakehouse table formats (Delta Lake, Apache Iceberg) layer typed metadata, optional schema enforcement, and first-class schema evolution onto files in object storage, enabling heterogeneous records to coexist without a global migration.

how_it_works:
  - Store the record as-is; keep schema separately; validate/coerce at read time.
  - Table formats track schema information in metadata files, adding "transactional semantics, schema enforcement, and time-travel queries to data stored in conventional [object storage]".
  - Schema enforcement is a POLICY (a writer may enforce; a reader may adapt), not a storage constraint; schema evolution is built in.
  - Semi-structured data explicitly "need not conform to a predefined database schema".
strengths:
  - Heterogeneous records (tools / papers / processes / patterns) coexist without a global rewrite.
  - Adding a content type = adding a reader + schema, not migrating the store — directly supports L2/L3.
  - The counterpart to a schema-on-write case library: cases carry profile-specific fields and are interpreted per profile at read.
weaknesses:
  - Read-time cost and ambiguity; no write-time validation → dirtier data and silent misinterpretation.
  - Schema drift and enforcement gaps let malformed records in.
  - Says nothing about retrieval, ranking, or reuse — it is storage architecture only.
references:
  - Wikipedia "Lakehouse" (retrieved 2026-09-25).
  - Wikipedia "Apache Iceberg", "Semi-structured data" (retrieved 2026-09-25).
  - Delta Lake / Apache Iceberg (vendor docs not fetched this run — fetch backend was down).
source:
  - Wikipedia (network provider search snippets, 2026-09-25)
data_quality: estimated
tags:
  - pattern:recommended
  - schema-on-read
  - schema-evolution
  - typed-output
  - storage-design
  - prior-art
summary: "Schema-on-read = store raw, apply a schema at read. Lakehouse table formats (Delta/Iceberg) add typed metadata + opt-in schema enforcement + schema evolution. This is the storage half of L3 profile-typed output: store a finding with its profile tag + profile-specific fields and validate per-profile at read — never a global write-time schema."

## What the source SAID vs what I INFERRED
- SAID (Wikipedia "Lakehouse" via Google snippet): table formats "add transactional semantics, schema enforcement, and time-travel queries to data stored in conventional [storage]".
- SAID (Wikipedia "Semi-structured data" via Google snippet): the data model "need not conform to a predefined database schema".
- SAID (Wikipedia "Apache Iceberg" via Google snippet): it "maintains metadata files that track snapshots, schema information, partition layouts, and data file locations".
- SAID (Wikipedia "Apache Parquet" via Google snippet): Parquet is a columnar format "inspired by Google Dremel ... for analysis of read-only nested data".
- INFERRED: "schema-on-read vs schema-on-write" is the storage-level expression of the same tension as "profile-driven interpretation"; enforcement being opt-in is what makes heterogeneous content types coexist.

## Confidence
- Schema-on-read concept + lakehouse typed metadata + schema evolution: **MEDIUM-HIGH** (multiple Wikipedia articles; not primary vendor docs — fetch backend down).
- "Enforcement is policy not constraint": **MEDIUM**.

## Verdict: ADOPT (adapt)
Adopt schema-on-read as the storage contract for L3: a finding carries a `profile`/content-type tag
plus profile-specific fields; validation happens per-profile at read. This directly rebuts any
schema-on-write case-library design (cf. sibling file `09-pattern-4r-cycle-case-representation.md`,
which flags the same schema-on-write trap).
