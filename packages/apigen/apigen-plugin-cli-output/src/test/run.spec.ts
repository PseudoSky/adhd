import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  run,
  buildCommandTable,
  matchCommand,
  resolveArgv,
  tokenizeShellLike,
} from '../lib/run';
import { buildFnTable } from '@adhd/apigen-engine-runtime';
import type {
  RunInput,
  Operation,
  ComposedSchemas,
  Segment,
} from '@adhd/apigen-core-client';
import { CLI_EXIT_CODE } from '@adhd/apigen-base-errors';
import * as backlogFixture from './fixtures/backlog.fixture';
import { getItem, listItems, deleteItem, whoAmI } from './fixtures/backlog.fixture';

// ---------------------------------------------------------------------------
// Real fn table from a REAL imported fixture module — the same helper
// (`buildFnTable`) `orchestrateRun` uses to build `RunInput.packages[].fns`
// from a live source import. Not a hand-rolled `{ name: () => ... }` stub.
// ---------------------------------------------------------------------------
const fns = buildFnTable(backlogFixture as unknown as Record<string, unknown>);

// ---------------------------------------------------------------------------
// Composed schemas matching the fixture's REAL signatures (mirrors what
// `composeSchemas()` would produce for these exports).
// ---------------------------------------------------------------------------
const schemas: ComposedSchemas = {
  getItem: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            includeArchived: { type: 'boolean' },
          },
          required: ['id'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
    'x-apigen-safe': true,
  },
  listItems: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: [],
        },
      },
      required: ['data'],
    },
    output: { type: 'array' },
    'x-apigen-safe': true,
  },
  deleteItem: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
    'x-apigen-safe': false,
  },
  whoAmI: {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
    // §9.1 — pluginId 'auth' → flag `--auth-session` / env `APIGEN_AUTH_SESSION`.
    'x-apigen-envelope': { session: 'auth' },
  },
};

// ---------------------------------------------------------------------------
// Real Operation descriptors — the naming authority (`project(op).cli.path`)
// is what run() must use for command routing, not the bare fn name.
// ---------------------------------------------------------------------------
function seg(raw: string, words: string[]): Segment {
  return { raw, words };
}

function makeOp(
  fnName: string,
  words: string[],
  schema: ComposedSchemas[string],
  safe: boolean
): Operation {
  return {
    id: `backlog/${words.join('-')}`,
    host: 'ts',
    namespace: seg('backlog', ['backlog']),
    path: [seg(fnName, words)],
    kind: 'action',
    async: false,
    streaming: false,
    safe,
    input: schema.input,
    output: schema.output,
    envelope: {},
    typeText: null,
  };
}

const operations: Operation[] = [
  makeOp('getItem', ['get', 'item'], schemas.getItem, true),
  makeOp('listItems', ['list', 'items'], schemas.listItems, true),
  makeOp('deleteItem', ['delete', 'item'], schemas.deleteItem, false),
  makeOp('whoAmI', ['who', 'am', 'i'], schemas.whoAmI, true),
];

function makeInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    packages: [{ id: 'backlog', schemas, importPath: '@test/backlog', fns }],
    outputDir: '/tmp/out',
    options: {},
    operations,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stdout/stderr capture — never touch the real process.exitCode across test
// boundaries (it would poison the vitest worker's own exit status), always
// reset it in afterEach.
// ---------------------------------------------------------------------------
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
  delete process.env['APIGEN_AUTH_SESSION'];
});

function lastLogJson(): unknown {
  const call = logSpy.mock.calls.at(-1);
  return JSON.parse(call?.[0] as string);
}

function lastErrJson(): { code: string; message: string } {
  const call = errSpy.mock.calls.at(-1);
  return JSON.parse(call?.[0] as string);
}

// ---------------------------------------------------------------------------
// argv resolution — pure helpers
// ---------------------------------------------------------------------------

describe('resolveArgv', () => {
  it('uses a real string[] from options.argv verbatim (the programmatic API)', () => {
    expect(resolveArgv({ argv: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('shell-tokenizes a string from options.argv (the --opt argv=… CLI delivery path)', () => {
    expect(resolveArgv({ argv: 'backlog get-item --id 5' })).toEqual([
      'backlog',
      'get-item',
      '--id',
      '5',
    ]);
  });

  it('honors quoted segments so a value can contain spaces', () => {
    expect(tokenizeShellLike(`backlog get-item --title "hello world"`)).toEqual([
      'backlog',
      'get-item',
      '--title',
      'hello world',
    ]);
  });

  it('falls back to process.argv.slice(2) when options.argv is absent', () => {
    const original = process.argv;
    process.argv = ['node', 'script.js', 'backlog', 'get-item'];
    try {
      expect(resolveArgv({})).toEqual(['backlog', 'get-item']);
    } finally {
      process.argv = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Command-table routing — the naming-authority contract (project(op).cli)
// ---------------------------------------------------------------------------

describe('buildCommandTable — naming-authority-driven nested CLI paths', () => {
  it('routes via project(op).cli.path (namespace-qualified nested kebab) when Operations are available', () => {
    const table = buildCommandTable({
      packages: [{ id: 'backlog', schemas, importPath: 'x' }],
      operations,
    });
    expect([...table.keys()].sort()).toEqual(
      [
        'backlog delete-item',
        'backlog get-item',
        'backlog list-items',
        'backlog who-am-i',
      ].sort()
    );
  });

  // [negative control] If run.ts regressed to flat `[fnName]` routing even
  // when real Operations are available (e.g. someone deletes the
  // `project(op).cli.path` call and reverts to `[fnName]` unconditionally),
  // this assertion goes red: the flat key would exist and the nested one
  // would not.
  it('[negative control] a bare fnName is NOT a valid command once Operations are available', () => {
    const table = buildCommandTable({
      packages: [{ id: 'backlog', schemas, importPath: 'x' }],
      operations,
    });
    expect(table.has('getItem')).toBe(false);
    expect(table.has('backlog get-item')).toBe(true);
  });

  it('falls back to a flat [fnName] command when no matching Operation exists', () => {
    const table = buildCommandTable({
      packages: [{ id: 'backlog', schemas, importPath: 'x' }],
    });
    expect(table.has('getItem')).toBe(true);
    expect(table.has('backlog get-item')).toBe(false);
  });
});

describe('matchCommand — longest registered prefix wins', () => {
  it('resolves a two-segment command and returns the remaining flags as rest', () => {
    const table = buildCommandTable({
      packages: [{ id: 'backlog', schemas, importPath: 'x' }],
      operations,
    });
    const match = matchCommand(['backlog', 'get-item', '--id', '5'], table);
    expect(match?.entry.fnName).toBe('getItem');
    expect(match?.rest).toEqual(['--id', '5']);
  });

  it('returns null for an unregistered command', () => {
    const table = buildCommandTable({
      packages: [{ id: 'backlog', schemas, importPath: 'x' }],
      operations,
    });
    expect(matchCommand(['backlog', 'nope'], table)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run() — live dispatch through the REAL invoker / validate-layer / dispatch
// stack (createInvoker + makeValidateLayer + dispatch, exactly as mcp/
// api-fastify's run.ts compose it). Ground truth is calling the fixture fn
// directly in the same test.
// ---------------------------------------------------------------------------

describe('run() — safe op, nested command, required + optional params', () => {
  it('dispatches "backlog get-item --id 42" and prints JSON identical to the direct call', async () => {
    await run(makeInput({ options: { argv: ['backlog', 'get-item', '--id', '42'] } }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(lastLogJson()).toEqual(getItem('42', undefined));
    expect(process.exitCode).toBeUndefined();
  });

  it('a boolean flag and its --no- negation both take effect', async () => {
    await run(
      makeInput({
        options: { argv: ['backlog', 'get-item', '--id', '1', '--include-archived'] },
      })
    );
    expect(lastLogJson()).toEqual(getItem('1', true));

    await run(
      makeInput({
        options: { argv: ['backlog', 'get-item', '--id', '1', '--no-include-archived'] },
      })
    );
    expect(lastLogJson()).toEqual(getItem('1', false));
  });

  it('accepts argv as a shell-tokenized string (the --opt argv=… CLI delivery path)', async () => {
    await run(makeInput({ options: { argv: 'backlog get-item --id 7' } }));
    expect(lastLogJson()).toEqual(getItem('7', undefined));
  });
});

describe('run() — unsafe (mutating) op', () => {
  it('dispatches "backlog delete-item --id 9" identically to the direct call', async () => {
    await run(makeInput({ options: { argv: ['backlog', 'delete-item', '--id', '9'] } }));
    expect(lastLogJson()).toEqual(deleteItem('9'));
  });
});

describe('run() — JSON-typed (array) param — BUG-APIGEN-031 parity', () => {
  it('parses a JSON array from its raw argv string', async () => {
    await run(
      makeInput({ options: { argv: ['backlog', 'list-items', '--tags', '["a","b"]'] } })
    );
    expect(lastLogJson()).toEqual(listItems(['a', 'b']));
  });

  it('an invalid JSON value is rejected with invalid_argument (not a crash)', async () => {
    await run(
      makeInput({ options: { argv: ['backlog', 'list-items', '--tags', 'not-json'] } })
    );
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(lastErrJson().code).toBe('invalid_argument');
    expect(process.exitCode).toBe(CLI_EXIT_CODE.invalid_argument);
  });
});

describe('run() — §9.1 envelope binding (--auth-session / APIGEN_AUTH_SESSION)', () => {
  it('the --auth-session flag satisfies a session-required schema', async () => {
    await run(
      makeInput({ options: { argv: ['backlog', 'who-am-i', '--auth-session', 'tok123'] } })
    );
    expect(lastLogJson()).toEqual(whoAmI());
    expect(process.exitCode).toBeUndefined();
  });

  it('the APIGEN_AUTH_SESSION env var satisfies it when the flag is absent (flag takes precedence over env when both present)', async () => {
    process.env['APIGEN_AUTH_SESSION'] = 'from-env';
    await run(makeInput({ options: { argv: ['backlog', 'who-am-i'] } }));
    expect(lastLogJson()).toEqual(whoAmI());
  });
});

describe('run() — validate-layer rejects bad input BEFORE the fn ever runs', () => {
  it('a missing required domain param is rejected as invalid_argument and the fn is never called', async () => {
    const spy = vi.fn(getItem);
    const spyFns = { ...fns, getItem: spy };
    await run(
      makeInput({
        packages: [{ id: 'backlog', schemas, importPath: 'x', fns: spyFns }],
        options: { argv: ['backlog', 'get-item'] },
      })
    );
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(lastErrJson().code).toBe('invalid_argument');
    expect(process.exitCode).toBe(CLI_EXIT_CODE.invalid_argument);
  });

  it('a missing required envelope field (session) is rejected as invalid_argument', async () => {
    await run(makeInput({ options: { argv: ['backlog', 'who-am-i'] } }));
    expect(process.exitCode).toBe(CLI_EXIT_CODE.invalid_argument);
  });

  it('an unknown flag is rejected as invalid_argument', async () => {
    await run(
      makeInput({ options: { argv: ['backlog', 'get-item', '--id', '1', '--bogus'] } })
    );
    expect(process.exitCode).toBe(CLI_EXIT_CODE.invalid_argument);
  });

  it('an unknown command is rejected as not_found', async () => {
    await run(makeInput({ options: { argv: ['backlog', 'nope'] } }));
    expect(lastErrJson().code).toBe('not_found');
    expect(process.exitCode).toBe(CLI_EXIT_CODE.not_found);
  });
});

describe('run() — help / usage listing (derived from the live command table)', () => {
  it('empty argv prints the command listing to stdout and does not set an exit code', async () => {
    await run(makeInput({ options: { argv: [] } }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('backlog get-item');
    expect(process.exitCode).toBeUndefined();
  });

  it('--help prints usage without dispatching anything', async () => {
    await run(makeInput({ options: { argv: ['--help'] } }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('a per-command --help prints only that command\'s usage', async () => {
    await run(makeInput({ options: { argv: ['backlog', 'get-item', '--help'] } }));
    expect(logSpy.mock.calls[0][0]).toContain('backlog get-item');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('run() — an already-aborted signal is a no-op', () => {
  it('does not resolve any command when input.signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await run(
      makeInput({
        options: { argv: ['backlog', 'get-item', '--id', '1'] },
        signal: controller.signal,
      })
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
