# @adhd/apigen-conformance

The apigen **conformance vectors** — a host-neutral suite that pins the canonical wire behavior
every host implementation (TypeScript, Python, …) must reproduce. A new host is conformant iff
it passes them. Pure TypeScript (**platform: shared**).

Part of [apigen](../README.md).

## Public API

```ts
import type { ValidationCase, VectorResult } from '@adhd/apigen-conformance'
```

Each vector names a schema + value and the exact expected result, forming the cross-host
contract used by the TypeScript and Python hosts (and any future host).
