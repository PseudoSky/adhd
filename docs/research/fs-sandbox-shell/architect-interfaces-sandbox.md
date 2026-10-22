# Interface specification: sandbox (kernel confinement and launcher)

Status: draft for owner review. Companion to `architect-spec-sandbox.md` (behaviors: SB, SX, SP and moved rows), `architect-interfaces.md` (the policy package) and `architect-interfaces-sources.md` (which defines `IProcessLauncher`). This document defines how the sandbox plugs into the policy system. The policy system names nothing here. Creating a package needs recorded human approval (BO-02 in `architect-spec.md`); the sandbox is a separate package and is never part of `@adhd/policy` (SO-01, SC-03).

## 1. What the sandbox uses from policy (the only coupling)

| From `@adhd/policy` | Used for |
|---|---|
| `IProcessLauncher` (defined by the apigen `bin` and `remote` sources, `architect-interfaces-sources.md` section 3) | The sandbox implements it, so the wrapper starts governed upstream processes under confinement |
| `resolve` operation (`IResolved`: the effective attributes) | The values the launcher maps to read and write scope through its own configuration (RS-01, CL-10) |
| `narrow`, `evaluate` | Child attributes and decisions, through any entrypoint of the policy package |
| `ICompiledPolicy`, `Attributes` | Types |

The sandbox never reads policy files and never evaluates expressions itself (scope comes from `resolve` output and the launcher's own configuration, decisions from the policy Layer).

## 2. Package surface (proposed)

| Import path | Contents |
|---|---|
| `@adhd/sandbox` (name pending) | `createSandboxLauncher`, `createSrtDriver`, driver and plan types |
| `bin: sbx` | Launcher CLI (section 5) |
| tools served via MCP | `sandbox.mount`, `sandbox.exec` (section 4) |

Dependencies: `@adhd/policy` (the client), `@anthropic-ai/sandbox-runtime`, the MCP SDK, apigen packages (CLI and tool projection), `@adhd/environment` for settings. Layer rule: nothing in `@adhd/policy` may import this package.

## 3. Driver and launcher interfaces

```typescript
export interface IConfinement {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly denyRead: readonly string[];       // secret and protected-path patterns (SB-04)
  readonly network: { readonly allow: readonly string[]; readonly deny: readonly string[] };
}

export interface ISandboxDriver {
  /** Wraps a command so it runs confined (SB-01, SB-02). Rejects if confinement cannot be established (SB-08). */
  wrap(command: ICommand, confinement: IConfinement): Promise<IWrappedCommand>;
  violations(sinceMs?: number): Promise<readonly IViolation[]>;     // SB-09
  doctor(): Promise<ISandboxDoctorReport>;                           // SB-10, PL-02
}

export interface ILaunchPlan {
  readonly command: ICommand;
  readonly confinement: IConfinement;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** The launcher's own mapping from effective attributes to confinement (RS-01). Owned by the sandbox package, not by policy. */
export interface ILauncherConfig {
  readonly readFrom: readonly string[];      // attribute names whose values become read scope
  readonly writeFrom: readonly string[];     // attribute names whose values become write scope
  readonly cwdFrom?: string;
  readonly denyRead: readonly string[];      // secret and protected-path patterns (SB-04)
  readonly network: { readonly allow: readonly string[]; readonly deny: readonly string[] };
}

/** Pure. Maps effective attributes to a plan; adds runtime files the server needs (SX-07). */
export function planLaunch(spec: IProcessSpec, attributes: Attributes, config: ILauncherConfig): ILaunchPlan;

/** The IProcessLauncher the apigen spawn runner is given. Fails closed: no driver or no plan means no process (FC-02). */
export function createSandboxLauncher(driver: ISandboxDriver): IProcessLauncher;

export function createSrtDriver(options?: ISrtDriverOptions): ISandboxDriver;  // wraps @anthropic-ai/sandbox-runtime
```

`denyRead` and `network` come from `ILauncherConfig` (SB-03, SB-04). Whether they could instead be derived from the proposed `residual` query over the secret-path `deny` permissions and the `net.connect` permissions is open (SO-02, OD-21).

## 4. Sandbox tools (apigen operations, MCP)

```typescript
// src/api/sandbox.ts  (served as `sandbox.mount`, `sandbox.exec` behind the apigen host with the policy Layer)
export async function mount(input: { server: string; grant?: Attributes; only?: Attributes }): Promise<IMountResult>;
export async function exec(input: { bin: string; args?: string[]; grant?: Attributes; only?: Attributes }): Promise<IExecResult>;
```
- They are ordinary operations behind the policy Layer. Narrowing, who may create what and the depth limit are policy permissions on these tool names and `child.*` (NR-*), enforced by the Layer before the tool runs. By the time the tool is called, the Layer has already called `narrow` and delivered the child attributes by the configured channel (DL-02).
- `mount` resolves `server` against the server catalog (`.mcp.json`), takes the child attributes the Layer delivered, calls `resolve` for them, plans and launches under the driver, and mounts the child's tools behind a new served source for the child (SX-01, SX-05, SX-08).
- `exec` resolves `bin` on the sandbox PATH only; paths and command lines are rejected (SX-02, SX-04).
- Schemas come from the TypeScript signatures through apigen (`mcpPlugin`), so the advertised schema, the arguments permissions filter, and the parameters cannot drift (IN-08). Names and namespace come from the naming authority, not annotations. Context (driver, refs, catalog) reaches the functions through the lazy-ctx pattern.

## 5. CLI

| Command | Behavior |
|---|---|
| `sbx run [--attributes <json or @file>] -- <cmd...>` | Run a command confined to the scope derived from the given attributes (plain `commander`, stdio passthrough) |
| `sbx verify` | Check that a confinement is real: attempt out-of-scope reads and writes and expect refusals |
| `sbx violations [--since]` | Recorded violations (SB-09) |
| `sbx doctor` | Platform and user-namespace readiness (SB-10, PL-02) |

`verify`, `violations` and `doctor` are apigen admin-style operations on the CLI only, never on MCP (SI-02).

## 6. Settings (through `@adhd/environment`)

```typescript
export interface ISandboxConfig {
  readonly sandbox: { readonly driver: string };          // default 'srt'
  readonly logging: { readonly level: string };
}
```
Environment prefix `ADHD_SANDBOX`; violation log and caches under `env.dirs`; `test` namespace for the package's own tests. Environment variables never widen confinement (EV-03).

## 7. File structure

```
<sandbox package>/
  src/
    index.ts                       # createSandboxLauncher, createSrtDriver, types
    launcher/{plan,launcher}.ts
    driver/{driver,srt-driver,doctor}.ts
    api/sandbox.ts                 # apigen operations -> MCP
    cli/{main.ts,commands/run.ts,api/admin.ts,config/env-spec.ts}
  test/
    unit/                          # planLaunch pure cases; launcher with a fake driver; fail-closed
    properties/                    # plan within plan when attributes within attributes (CP/SB-05)
    integration/                   # real driver on a temp tree under tmp/sandbox/
    e2e/
      sandbox-proof/               # SP-01..SP-13 on macOS and Linux
      mount-exec.e2e.test.ts       # real `serve` + real tools + real nested launch
    fixtures/  helpers/{fake-driver,mcp-client}.ts
```

## 8. Tests and build order

- Proof first: the SP suite runs before any other sandbox code is built; red items change this design (SP-12).
- Unit and property tests prove `planLaunch` and fail-closed behavior without a kernel; e2e proves the kernel.
- Negative controls per `architect-spec-sandbox.md` (SPS table).
- Gates: `npx nx affected -t lint,typecheck,typecheck-spec`, `test`, `e2e`, `verify-dist-load` for the package entry and the bin.

## 9. Open items

| ID | Item |
|---|---|
| SO-01 | Package name and approval; the sandbox is a separate package (behavior spec). |
| SO-02 | Source of `denyRead` and `network`: launcher configuration, or the proposed `residual` query (OD-21). |
| SO-03 | How a mounted server receives its child attributes (DL-02). |
| SO-04 | Driver choice beyond `sandbox-runtime` (bubblewrap, container, VM) and the cost of keeping the interface engine-neutral. |
