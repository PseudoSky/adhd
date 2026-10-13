# `adhd-policy serve` wrapper overhead measurements

Measured 2026-10-13 against `entrypoint/policy/dist/cli.js` as built. Every number below comes from a scripted run in this session; the raw JSON (one file per run) and the scripts live outside the repo in `/private/tmp/claude-502/-Users-nix-dev-node-adhd/3de79056-6e63-48e2-819d-be8049082bdd/scratchpad/measure/` (`raw/`, `raw2/`). Figures are median (min-max) over runs unless a single value is given.

## 0. What was measured, and its limits

- **Build under test:** `entrypoint/policy/dist/cli.js` mtime `2026-10-13 13:04:58 -0400` (`api.ir.json` 13:05). It was built BEFORE gateway fixes `0ccf5296` (13:48:57, never stamp x-apigen-safe on MCP-sourced composed schemas), `56c6bcda` (13:49:08, launcher transport close is a no-op once closed) and `1615953d` (13:51:04, forward Layer-forced arguments to the upstream). The gateway is bundled into `dist/src-*.js`, so those fixes are NOT in the measured binary. Worktree HEAD at measurement start was `889522ec`; the only code under test is the prebuilt `dist/`. Re-measure after the next build before quoting these as final.
- **Machine:** Apple M1 Max, 10 cores, 32 GiB RAM (`hw.memsize` 34359738368), macOS 15.0 (Darwin 24.0.0 arm64, `uname -a`: `Darwin MacBookPro.ht.home 24.0.0 ... RELEASE_ARM64_T6000`), Node v24.11.1, `@modelcontextprotocol/sdk` 1.29.0. V8 `heap_size_limit` 4288 MB (default, derived from RAM).
- **Node flags / heap defaults:** none. The host launches `node <script> ...`; the wrapper launches the upstream as `node stub.mjs` with no added flags (visible in the `ps` command column below). No `NODE_OPTIONS`, no `--max-old-space-size`. The wrapper gives the upstream only `PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL`.
- **Load caveat (important):** the machine was shared with other agents. `uptime` load averages were 17.3 / 17.6 / 14.1 at the start of the benchmark phase and 30.6 / 24.0 / 17.6 during the first variant pass (10-core machine). Latency and startup figures therefore carry contention noise (visible in the max columns and in the 10-20 run spread); RSS and process-count figures are not affected by load. The variant experiment was re-run (section 6) when load was about 10.5.
- **RSS caveat:** RSS from `ps` counts shared pages (the node binary and shared libraries) in every process, so "sum RSS" overstates the true marginal system memory of an extra process. I did not measure USS/PSS or macOS `footprint`, so the exact marginal cost of the extra process is NOT known; the sum-RSS delta is an upper bound on it. macOS also compresses idle pages, which is why idle RSS falls over 60 s (section 4).
- **Not measured:** Linux behaviour; any network-backed real-world MCP server (only `@modelcontextprotocol/server-filesystem`, which is installed locally, was used); the cost of the `initTelemetry({logSink:"file"})` file sink on disk; the wrapper with a large real-world policy file (the policy here has 5 rules); the difference between baked-IR and live extraction in time (live extraction was never triggered, so there is no "after" to compare); CPU numbers finer than the 10 ms `ps cputime` resolution; PSS/USS.

## 1. Setup

- **Stub upstream** (`stub.mjs`, real MCP stdio server on the SDK low-level `Server`): tools `echo` (returns its text), `big` (returns exactly 102,400 bytes), `secret` (increments a counter; used to prove a denied call never reaches the upstream), `count` (returns the counter), plus N filler tools when started with `node stub.mjs N` (N=50 for the list-size case).
- **Policy** (`policy.yaml`): `node.echo`, `node.big`, `node.count`, `node.t*` allowed (no args constraints); `node.secret` explicit deny. Operation ids are `<name>.<tool>` and the name defaults to the command basename (`node`).
- **Host driver:** real SDK `Client` over `StdioClientTransport`. A = host -> `node stub.mjs`. B = host -> `node entrypoint/policy/dist/cli.js serve bin:node --spec policy.yaml -- stub.mjs`.
- Process trees come from `ps -ax -o pid,ppid,rss,vsz,%cpu,etime,cputime,command`, walked from the pid the host spawned. The host driver is excluded from every RSS figure. Peak runs wrap the launched command in `/usr/bin/time -l`.
- 10 runs per configuration for each scenario (15 for the variant experiment, 7 for the import-increment experiment). A and B runs alternate.

## 2. Headline: cost of wrapping one server

| metric | A baseline | B wrapped | delta (B - A) |
|---|---|---|---|
| processes | 1 | 2 | +1 |
| sum RSS after initialize (MB) | 77.3 | 191.3 | +113.9 |
| sum RSS after 1,000 sequential calls (MB) | 98.3 | 233.1 | +134.9 |
| sum RSS after 100 concurrent calls (MB) | 98.9 | 239.7 | +140.8 |
| peak RSS of largest process, full load run (MB, `time -l`) | 120.1 | 261.9 | +141.9 |
| open fds (lsof -p lines, whole tree) | 14 | 35 | +21 |
| spawn -> initialize (ms) | 101.5 | 345.2 | +243.7 |
| per-call p50, tiny allow (ms) | 0.091 | 0.265 | +0.175 |
| per-call p99, tiny allow (ms) | 0.442 | 1.076 | +0.634 |
| per-call p50, 100 KiB allow (ms) | 0.293 | 0.756 | +0.463 |
| deny path p50 (ms; A column = upstream executes the call) | 0.072 | 0.109 | +0.037 |
| CPU s per 1,000 calls (tree) | 0.100 | 0.370 | +0.270 |
| teardown (close -> all processes gone, ms) | 5.7 | 13.8 | +8.1 |
| 20 copies: sum RSS (MB) / processes | 1592.9 / 20 | 3850.9 / 40 | +2258 / +20 |
| 20 copies: wall to all initialized (ms) | 404 | 1620 | +1216 |

Deny correctness: all 1,000 denied calls per run came back `isError`; the upstream `secret` counter read `0` in every one of the 10 B runs (and `1000` in the A runs, where no policy exists). A denied call never reaches the upstream. Wrapped output equals unwrapped output: the 100 KiB payload arrived intact (102,400 bytes) in all runs.

Cost per wrapped server, measured: about +114 MB RSS at idle (the wrapper process alone is 114.4 MB; the upstream is unchanged at 77.0 MB), +1 process, +21 fds, about +240 ms startup, about +0.18 ms per tiny call, about +0.27 CPU-seconds per 1,000 calls. It scales linearly: 192.5 MB per wrapped copy at N=20 against 79.6 MB bare.

## 3. Where the memory goes

Measured breakdown of the wrapper process (114 MB after initialize):

| component | evidence | MB |
|---|---|---|
| bare `node -e setInterval` | 10 runs: 40.7 (40.2-41.6) | ~41 |
| SDK server/stdio/types/client (+ zod) | stub (A) = 77.3 MB, i.e. +36.6 over bare; fresh-process import test: +32.8 (31.9-33.8) | ~33-37 |
| `fastify` (static import in `run-entry`, unused by `serve`) | import increment +7.2 (6.2-8.2) after SDK; +14.0 (13.5-14.7) when loaded first; removing it from a dist copy: -13.1 wrapper RSS (section 6) | 7-14 |
| SDK SSE + StreamableHTTP transports (static, unused by `serve`) | +4.3 (3.7-7.2) after SDK; removing them on top of V3: -1.7 | 2-4 |
| `@adhd/sox-telemetry` (OpenTelemetry sdk-metrics/trace/api/core/resources, pino) | +0.5 to +1.2 in isolation, but replacing it with a stub in the dist copy: -6.9 | 1-7 |
| remainder (bundled apigen/policy code, ajv schema compilation, policy compile, heap growth) | wrapper `heapUsed` 35.4 MB vs stub 14.3 MB; `heapTotal` 58.9 vs 32.0; `external` 3.6 vs 1.9 at t=4 s | ~25 |

Cross-check against the memory snapshot taken inside each process at t=4 s (`process.memoryUsage()` via a preload): wrapper RSS 110.9 MB = heapTotal 58.9 + external 3.6 + ~48 other; stub RSS 80.6 MB = heapTotal 32.0 + external 1.9 + ~47 other. The "other" (node binary, code space, stacks) is the same for both, so the wrapper's extra ~30 MB over a plain SDK server is almost entirely V8 heap: +27 MB heapTotal / +21 MB heapUsed. That heap is the product of loading far more code: 709 unique module files / 3.77 MB of source in the wrapper versus 220 files / 1.24 MB in the SDK-only stub (`module.registerHooks` load trace).

Modules loaded at `serve` time in the wrapper (709 unique files; count / source KB), from the trace:

| package | files | KB | loaded by the SDK-only stub? |
|---|---|---|---|
| zod | 97 | 735 | yes (SDK) |
| @opentelemetry/* (semantic-conventions 9 files 317 KB, sdk-metrics 53 files 171 KB, sdk-trace 26, api 44, core 32, resources 17) | ~191 | ~741 | no |
| @adhd/sox-telemetry | 15 | 176 | no |
| ajv | 85 | 270 | partly (63 files, via SDK client) |
| @modelcontextprotocol/sdk | 16 | 253 | partly (11 files) |
| fastify (+ fast-json-stringify 6, find-my-way 10, avvio 13, pino 24, thread-stream 8, ...) | 29 (+~100) | 238 (+~300) | no |
| yaml | 8 | 174 | no |
| policy `dist/*.js` (bundles apigen-core/runtime/gateway/plugins) | 8 | 273 | no |

**`typescript`, `ts-morph` and `ts-json-schema-generator` are NOT loaded on the `serve` path (0 files in the trace), and `ir-live-*.js` (live extraction) is not loaded either.** The baked `api.ir.json` path was taken: no "ignoring the baked operation surface" warning appeared (stderr was exactly one line, `policy: <spec path>`), and the only `dist/` files loaded were `cli`, `run-entry`, `serve`, `gate`, `failure`, `package`, `src-BJrsOhKU`, `src-Cep0PK6e`. The heavy modules that DO load (fastify, OpenTelemetry, SSE/StreamableHTTP, yaml) are static imports at the top of `run-entry-DY4QERRm.js` (lines 10, 18 and the SDK imports), shared by every verb, so `serve` pays for HTTP and tracing code it does not use.

Startup profile (`--cpu-prof`, one run, 438 ms sampled in the wrapper): 154 ms node internals (module compile and linking), 57 ms `readFileUtf8`, 33 ms `internalModuleStat`, 10 ms `readPackageJSON`, 19 ms zod, 18 ms ajv, 2.5 ms fastify, 97 ms idle. Startup is dominated by loading roughly 700 files, not by policy logic. The startup `git` spawn happens 249 ms after wrapper process start and the upstream is spawned at 339 ms (`child_process` spy, one run, under load). Exactly one `git rev-parse HEAD` `spawnSync` runs at startup (5.5 ms), visible as a short-lived `(git)` child in the peak-sampling runs; it comes from `@adhd/sox-telemetry` runtime state.

Peak growth: the wrapper process grows from 114 MB (initialize) to 137 MB (1,000 calls) to 143 MB (100 concurrent) and to 261.9 MB at its peak once 300 round trips of a 100 KiB payload have passed through it, while the upstream stays near 96-120 MB. The cause was not diagnosed (buffering plus V8 not returning garbage to the OS is a hypothesis, not a measurement).

## 4. Per-scenario results

The tables below are the aggregate output of the run scripts, unedited except that the V-variant table is the 15-run set.

runs: A=10 B=10

### RSS/process count by phase (MB; median (min-max) over runs)
| phase | A procs | A sum RSS | B procs | B sum RSS | B wrapper proc RSS | B upstream RSS | delta sum (B-A) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 after initialize | 1 (1-1) | 77.3 (76.2-78.3) | 2 (2-2) | 191.3 (189.2-193.2) | 114.4 (112.9-116.3) | 77.0 (76.0-77.4) | +113.9 |
| 2 after tools/list | 1 (1-1) | 77.4 (76.3-78.3) | 2 (2-2) | 191.3 (189.2-193.2) | 114.5 (112.9-116.4) | 77.0 (76.0-77.4) | +113.9 |
| 3 after 1,000 sequential calls | 1 (1-1) | 98.3 (94.9-99.8) | 2 (2-2) | 233.1 (228.4-240.8) | 137.0 (132.8-144.9) | 95.8 (94.5-97.2) | +134.9 |
| 4 after 100 concurrent | 1 (1-1) | 98.9 (95.4-100.4) | 2 (2-2) | 239.7 (234.7-247.1) | 142.6 (138.5-150.6) | 96.4 (95.2-99.7) | +140.8 |

A stub process RSS per phase: s1=77.3 (76.2-78.3), s2=77.4 (76.3-78.3), s3=98.3 (94.9-99.8), s4=98.9 (95.4-100.4)

VSZ after initialize: about 393 GB per node process (402,6xx MB; V8 address-space reservation on arm64 macOS), so A sum ~393 GB and B sum ~786 GB; not a meaningful memory figure and not used below

Example process tree (B, phase 2):
    pid=20367 ppid=20358 rss=112.9MB vsz=403184MB cpu%=40 etime=00:01 cpu=0.43s cmd=node $WT/entrypoint/policy/dist/cli.js serve bin:node --spec $D/policy.yaml -- /private/tmp/claude-502/-Users-nix-dev-node-adhd/3de79056-6e63-48e2-819d-be804908
    pid=20396 ppid=20367 rss=77.2MB vsz=402773MB cpu%=16.2 etime=00:00 cpu=0.15s cmd=node $D/stub.mjs
Example process tree (A, phase 2):
    pid=20006 ppid=19997 rss=77.4MB vsz=402772MB cpu%=42.7 etime=00:00 cpu=0.14s cmd=node $D/stub.mjs

### Startup / teardown latency (ms)
| metric | A | B | delta (median) |
| --- | --- | --- | --- |
| spawn -> initialize response | 101.5 (98.7-110.0) | 345.2 (332.7-582.1) | +243.7 |
| first tools/list | 1.8 (1.6-2.2) | 1.7 (1.6-1.9) | -0.1 |
| spawn -> first tools/list done | 147.7 (143.8-157.1) | 392.7 (379.2-629.5) | +245.0 |
| client.close() returns | 5.6 (5.3-6.8) | 13.7 (12.3-18.4) | +8.1 |
| close() -> every process in tree gone | 5.7 (5.3-6.9) | 13.8 (12.4-18.5) | +8.1 |

leftover processes after teardown: A 0, B 0

### Per-call latency (ms; per-run percentile, then median (min-max) across runs)
| workload | cfg | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| echo, tiny payload, allow, 1000 seq | A | 0.091 (0.088-0.097) | 0.190 (0.175-0.227) | 0.442 (0.386-0.497) | 1.92 (1.74-2.46) |
| echo, tiny payload, allow, 1000 seq | B | 0.265 (0.238-0.284) | 0.577 (0.541-0.667) | 1.076 (0.968-1.500) | 9.88 (8.81-10.58) |
| big, 100 KiB payload, allow, 300 seq | A | 0.293 (0.284-0.347) | 0.422 (0.403-0.513) | 0.743 (0.669-0.894) | 1.17 (0.95-1.74) |
| big, 100 KiB payload, allow, 300 seq | B | 0.756 (0.715-0.784) | 1.257 (1.135-1.391) | 2.609 (1.911-3.359) | 3.25 (2.83-4.37) |
| secret, DENY path, 1000 seq (A: upstream executes) | A | 0.072 (0.068-0.076) | 0.109 (0.103-0.125) | 0.184 (0.155-0.211) | 1.73 (1.57-2.32) |
| secret, DENY path, 1000 seq | B | 0.109 (0.105-0.111) | 0.177 (0.157-0.206) | 0.286 (0.218-0.334) | 2.19 (1.95-2.76) |

delta p50 (B-A, ms): tiny +0.175 ; 100KiB +0.463 ; deny(B) vs A upstream secret +0.037
100 KiB payload length received by host: A {102400} B {102400}
deny correctness: B isError count per run [1000]/1000, upstream secret-tool executions after 1000 denied calls: B ['0'] ; A (allowed, no policy) executions ['1000']

100 concurrent echo calls wall ms: A 3.7 (3.4-4.1) B 8.6 (8.2-10.1)

### CPU time per 1,000 sequential calls (sum over process tree, ps cputime, 10 ms resolution, s)
A 0.100 (0.100-0.120)  B 0.370 (0.350-0.400)  delta +0.270

### Open file descriptors (lsof -p lines, after 100 concurrent)
A (stub): 14 (14-14) ; B wrapper: 21 (21-21) ; B upstream: 14 (14-14) ; B total 35 (35-35) vs A total 14 (14-14)

### Peak RSS and CPU of a full launch -> 1000 calls + 100 concurrent + 300x100KiB + 1000 denied -> teardown run (/usr/bin/time -l wrapping the launched command; the stub and wrapper+stub respectively)
| metric | A | B | delta |
| --- | --- | --- | --- |
| max resident set size of the largest single process (MB) | 120.1 (118.5-122.2) | 261.9 (259.6-265.9) | +141.9 |
| peak memory footprint of the parent process (MB) | 92.4 (90.8-94.5) | 226.9 (224.1-231.4) | +134.5 |
| user CPU s (whole tree incl. waited children) | 0.33 (0.31-0.34) | 1.02 (0.95-1.08) | +0.70 |
| sys CPU s | 0.05 (0.05-0.06) | 0.20 (0.18-0.23) | +0.15 |
| wall s | 1.10 (1.01-1.16) | 2.00 (1.84-2.17) | +0.90 |
| sampled peak RSS (ps every 75 ms), stub process (MB) | 115.1 (113.6-117.2) | 110.3 (108.8-114.3) |  |
| sampled peak RSS, wrapper process (MB) | - | 260.7 (249.0-265.2) |  |

### Real-world server: @modelcontextprotocol/server-filesystem (tools: 14)
| metric | A | B | delta |
| --- | --- | --- | --- |
| sum RSS after initialize (MB) | 80.5 (79.3-82.8) | 193.9 (192.5-194.9) | +113.4 |
| sum RSS after tools/list | 80.7 (79.5-82.9) | 193.9 (192.5-194.9) | +113.2 |
| sum RSS after 200 calls | 81.8 (81.0-83.9) | 201.1 (199.0-201.6) | +119.4 |
| sum RSS after 100 concurrent | 85.6 (84.9-87.7) | 210.3 (207.7-211.6) | +124.7 |
| upstream process RSS after initialize (MB) | 80.5 (79.3-82.8) | 81.2 (80.3-82.0) |  |
| wrapper process RSS after initialize (MB) | - | 112.6 (112.1-113.9) |  |
| spawn -> initialize (ms) | 113.6 (107.2-137.2) | 345.5 (337.1-351.8) | +231.9 |
| list_allowed_directories p50 (ms) | 0.125 (0.120-0.149) | 0.340 (0.302-0.367) | +0.214 |
| process count | 1 (1-1) | 2 (2-2) |  |

### tools/list size (200 repeated listTools, ms; and RSS)
| tools | cfg | list p50 | list p95 | sum RSS after 200 (MB) | wrapper RSS (MB) |
| --- | --- | --- | --- | --- | --- |
| 4 | A | 0.135 (0.123-0.150) | 0.271 (0.249-0.327) | 78.5 (77.4-79.7) | - |
| 4 | B | 0.132 (0.123-0.146) | 0.266 (0.241-0.330) | 192.0 (190.6-193.8) | 115.8 (114.7-117.5) |
| 50 | A | 0.215 (0.210-0.232) | 0.459 (0.389-0.513) | 78.9 (78.0-81.8) | - |
| 50 | B | 0.219 (0.208-0.241) | 0.463 (0.426-0.516) | 192.9 (181.6-196.1) | 117.9 (106.9-119.2) |
first tools/list ms: 4-tool A: 2.0 (1.8-2.1); 4-tool B: 1.7 (1.5-2.1); 50-tool A: 2.2 (2.0-2.5); 50-tool B: 2.0 (1.9-2.1)

### Scaling: N concurrent copies of the same stub (10 runs each; MB, ms)
| N | cfg | processes | sum RSS (MB) | wall: all initialized (ms) | wall: all listed (ms) | teardown all gone (ms) | RSS per copy (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | 1 (1-1) | 77.4 (75.8-78.8) | 100 (95-198) | 102 (97-200) | 4 (4-6) | 77.4 (75.8-78.8) |
| 1 | B | 2 (2-2) | 191.7 (188.0-195.3) | 337 (319-722) | 338 (320-728) | 7 (7-15) | 191.7 (188.0-195.3) |
| 5 | A | 5 (5-5) | 393.8 (392.0-395.9) | 126 (120-554) | 129 (124-557) | 5 (5-30) | 78.8 (78.4-79.2) |
| 5 | B | 10 (10-10) | 968.6 (943.4-992.5) | 485 (418-898) | 486 (420-905) | 14 (10-19) | 193.7 (188.7-198.5) |
| 10 | A | 10 (10-10) | 797.0 (789.9-805.3) | 209 (192-455) | 212 (194-458) | 8 (7-23) | 79.7 (79.0-80.5) |
| 10 | B | 20 (20-20) | 1930.7 (1905.8-1983.7) | 832 (677-1360) | 835 (679-1367) | 21 (16-62) | 193.1 (190.6-198.4) |
| 20 | A | 20 (20-20) | 1592.9 (1579.5-1606.5) | 404 (367-680) | 409 (371-712) | 15 (13-30) | 79.6 (79.0-80.3) |
| 20 | B | 40 (40-40) | 3850.9 (3248.6-3897.7) | 1620 (1457-2359) | 1627 (1460-2366) | 55 (41-84) | 192.5 (162.4-194.9) |

### 60 s idle (10 A + 10 B ran concurrently; MB)
| metric | A | B |
| --- | --- | --- |
| procs | 1 (1-1) | 2 (2-2) |
| sum RSS at start | 79.8 (78.3-81.8) | 189.4 (183.6-206.8) |
| sum RSS after 60 s idle | 45.3 (40.0-69.6) | 165.4 (158.9-176.7) |
| wrapper RSS at start / after 60 s | - | 109.9 (105.0-127.4) / 95.7 (87.5-106.4) |
| upstream RSS at start / after 60 s | 79.8 (78.3-81.8) / 45.3 (40.0-69.6) | 79.5 (78.7-80.5) / 70.4 (68.9-74.1) |
| CPU seconds consumed over the 60 s (tree, ps cputime delta) | 0.00 (0.00-0.01) | 0.02 (0.02-0.03) |

### Bare `node -e setInterval` idle RSS (MB, 10 runs): 40.7 (40.2-41.6)

### Reduction experiments (see section 6)
| variant (scratch copy of dist, 15 runs each, interleaved) | wrapper RSS MB | sum RSS MB | spawn->initialize ms | delta wrapper RSS | delta init ms |
| --- | --- | --- | --- | --- | --- |
| V0 control: unmodified copy | 113.4 (110.3-116.1) | 188.7 (184.7-193.9) | 325 (310-403) | +0.0 | +0 |
| V1 `import fastify` removed | 100.3 (98.5-103.3) | 175.9 (173.0-181.9) | 294 (280-541) | -13.1 | -31 |
| V2 `@adhd/sox-telemetry` replaced by a no-op stub (upper bound, not a safe change) | 106.5 (104.0-115.9) | 184.3 (179.3-192.3) | 280 (267-387) | -6.9 | -45 |
| V3 = V1 + V2 | 96.2 (94.5-106.5) | 173.2 (170.0-182.3) | 245 (233-275) | -17.2 | -80 |
| V4 = V3 + SDK SSE and StreamableHTTP imports removed | 94.5 (93.6-96.3) | 170.8 (168.2-174.9) | 239 (224-492) | -18.9 | -86 |

All five variants passed a functional check through the real SDK client: allow returned the echoed text and the denied call returned isError.

### Incremental RSS of imports in a fresh node process (MB, 7 runs; cumulative, forward order, and reverse order)
| step | fwd cumulative RSS | fwd step delta | rev: step delta |
| --- | --- | --- | --- |
| bare node | 43.1 (42.8-43.5) | 43.1 (42.8-43.5) | 42.6 (42.3-43.2) |
| sdk server+stdio+types+client | 75.8 (75.4-76.7) | 32.8 (31.9-33.8) | 1.9 (1.4-2.3) |
| ajv + ajv-formats | 75.9 (75.5-76.8) | 0.2 (0.1-0.3) | 0.0 (0.0-0.0) |
| yaml | 76.6 (76.0-77.5) | 0.6 (0.5-0.9) | 0.1 (0.0-0.2) |
| fastify | 83.7 (82.8-84.9) | 7.2 (6.2-8.2) | 14.0 (13.5-14.7) |
| pino | 84.0 (82.8-84.9) | 0.1 (0.0-0.2) | 1.0 (0.9-1.0) |
| @adhd/sox-telemetry (OpenTelemetry) | 84.5 (83.4-85.2) | 0.5 (0.4-0.6) | 1.2 (1.2-1.3) |
| sdk sse+streamableHttp | 89.5 (87.5-90.8) | 4.3 (3.7-7.2) | 33.4 (32.5-45.0) |

## 5. Where the cost is, by reading the tables

- Memory: the wrapper's fixed cost is ~114 MB, of which ~41 MB is Node itself and ~33-37 MB the SDK, i.e. ~40 MB is attributable to our bundle and the packages it statically imports; of that, 13-19 MB is code that `serve` never executes (fastify, SSE/StreamableHTTP transports, OpenTelemetry).
- Latency per call: +0.175 ms p50 for a tiny allowed call, +0.46 ms for a 100 KiB payload (two extra JSON parse/serialize hops through a second process), +0.037 ms for a denied call versus the upstream executing it. Tool-list size does not matter: the wrapped `tools/list` p50 is 0.132 ms (4 tools) and 0.219 ms (50 tools) against 0.135 and 0.215 bare, a difference inside the noise.
- Startup: +244 ms (spawn -> initialize), dominated by module loading in the wrapper (section 3), paid once per server and linear when many servers start at once (20 copies: 1,620 ms to all initialized vs 404 bare).
- Idle: 0.02 CPU-seconds over 60 s for the B tree versus 0.00 for A (10 ms `ps` resolution). RSS falls over the idle minute on macOS because idle pages are compressed (A upstream 79.8 -> 45.3 MB, B wrapper 109.9 -> 95.7 MB), so idle RSS after 60 s is not a floor you can budget against.

## 6. Reduction options (measured on a scratch copy of `dist/`; `dist/` in the repo was not touched)

Method: copy `entrypoint/policy/dist/` to the scratch directory, symlink the worktree `node_modules`, patch the copy, and run it through the same real-client harness (initialize, list, one allowed call, one denied call, 1.5 s settle, read RSS). 15 interleaved runs per variant at load about 10.5. The table in section 4 ("Reduction experiments") has the numbers; the first 10-run pass at load 30 pointed the same direction with wider ranges (fastify removal -7.1 MB, both removals -10.8 MB, all three -14.0 MB).

1. **Stop importing `fastify` at `serve` time** (make the HTTP-server verbs load it lazily, or split the bins so `cli.js` does not carry it): measured -13.1 MB wrapper RSS (113.4 -> 100.3) and -31 ms initialize (325 -> 294). Both runs passed the functional check. This is the largest single lever.
2. **Load the SDK SSE and StreamableHTTP transports lazily** (only the HTTP/SSE verbs use them): measured -2 to -4 MB on top of V3 (V3 96.2 -> V4 94.5 wrapper RSS, 245 -> 239 ms).
3. **Load telemetry lazily or behind a switch** (OpenTelemetry sdk-metrics/trace plus pino ride on `@adhd/sox-telemetry`): the no-op stub removed 6.9 MB and 45 ms (V2 vs V0). This is an upper bound: the stub drops the real tracing behaviour, so it is not a drop-in change, and V3 (fastify + telemetry) measured -17.2 MB and -80 ms (96.2 MB, 245 ms) and V4 (plus transports) -18.9 MB and -86 ms (94.5 MB, 239 ms) against the control. Only options 1 and 2 are semantics-preserving as tested; option 3 needs a design that keeps spans.

Not tried, so no estimate: bundling with a smaller module count (one file instead of ~700 would cut the file-read and resolution time in the profile but its memory effect was not measured), and running the upstream and the gate in a single process (the process count is the dominant structural cost, but the upstream is deliberately a separate process group).

## 7. Reproduce

All commands run with cwd `/private/tmp/claude-502/-Users-nix-dev-node-adhd/3de79056-6e63-48e2-819d-be8049082bdd/scratchpad/measure` (scripts are not in the repo):

```bash
node main.mjs A raw/main_A_01.json            # baseline run: phases 1-4, latencies, fds, teardown
node main.mjs B raw/main_B_01.json            # wrapped
SAMPLE=1 TIME=1 node main.mjs B raw/peak_B_01.json   # /usr/bin/time -l + 75 ms ps sampling
node main.mjs B raw/fs_B_01.json fs           # server-filesystem as the upstream
node list.mjs B 50 raw/list50_B_01.json       # 50-tool upstream, 200 listTools
node scale.mjs B 20 raw/scale20_B_01.json     # 20 concurrent wrapped copies
node idle.mjs B raw/idle_B_01.json            # 60 s idle
node bare.mjs raw/bare.json                   # bare node idle RSS
node incr.mjs fwd                             # incremental import RSS
TRACE_OUT=tr_B.txt node tracerun.mjs B tr_B.txt   # module-load list (module.registerHooks) + heap stats
node spyrun.mjs                               # --cpu-prof + child_process spy
node variant.mjs v3 raw2/var_v3_01.json       # patched-copy reduction experiments
python3 agg.py                                # aggregate the raw JSON into the tables
```

Driver core (identical for A and B apart from the command): `new StdioClientTransport({command:'node', args: B ? [cli.js,'serve','bin:node','--spec',policy.yaml,'--',stub.mjs] : [stub.mjs]})`, `Client.connect`, `listTools`, 1,000 sequential `callTool({name:'echo'})` timed with `process.hrtime.bigint()`, `Promise.all` of 100 calls, 300 `big`, 1,000 `secret`, `close()`.

Stub policy used:

```yaml
version: 1
permissions:
  - tool: node.echo
  - tool: node.big
  - tool: node.count
  - tool: node.t*
  - tool: node.secret
    effect: deny
```

## 8. Bugs and deferrals found while measuring

1. `serve` statically loads `fastify`, the SDK SSE and StreamableHTTP transports and OpenTelemetry (via `@adhd/sox-telemetry`) through `run-entry`, none of which the stdio gateway uses: 13-19 MB RSS and 80-86 ms startup per wrapped server (section 6). Deferral: lazy-load per verb.
2. The measured `dist/` predates gateway fixes `0ccf5296`, `56c6bcda`, `1615953d`; all numbers should be re-taken after the next build.
3. The wrapper process peaks at 261.9 MB under 100 KiB payloads (114 MB at idle), roughly 2.3x its idle size; cause undiagnosed.
4. `@adhd/sox-telemetry` spawns `git rev-parse HEAD` synchronously at startup (5.5 ms measured) and `initTelemetry` is called with `logSink: "file"`; the disk side effect of that sink was not measured.
5. `serve` prints `policy: <path>` to stderr on every start (README documents this); noted only because stderr is not empty for a host that treats any stderr as a warning.
