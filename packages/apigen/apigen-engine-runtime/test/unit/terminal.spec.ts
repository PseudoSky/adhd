/**
 * guards: a binding-aware terminal is bypassed (dispatch runs instead), receives a rebuilt rather than the flat argument object, loses the call's signal, or its absence changes the default dispatch path
 * tier: S
 * cites: REMEDIATION-PLAN T-D1 (scenario "a flat-argument operation runs through the terminal"; two DoD clauses); ADR-0017 D7; ADR-0019 D4
 * tags: contract
 * teeth: red: ignore `options.terminal` in createInvoker (`const terminal = undefined`, guarded temporary edit, restored) and run `npx vitest run src/test/terminal.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; the terminal cases fail with `apigen/invoke: no schema found for operation` / the dispatch result instead of "saved". Always-use-terminal control: ignore the `terminal === undefined` branch -> the "without a terminal" cases go red
 */
import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '@adhd/apigen-core-client';
import { createInvoker, LayerContext, type Call, type Layer, type Terminal } from '../../src/lib/invoke';
import { createPackageInvoker } from '../../src/lib/package-invoker';
import type { ComposedSchemas } from '../../src/lib/types';

const notesOp = { id: 'notes/save', host: 'mcp', binding: 'mcp:notes' } as Operation;

function makeCall(signal?: AbortSignal): Call {
  return {
    operation: notesOp,
    ctx: new LayerContext(),
    envelope: {},
    domainArgs: { text: 'hi' },
    transport: 'mcp',
    ...(signal !== undefined ? { signal } : {}),
  };
}

const dispatched = vi.fn(() => 'dispatched');

describe('createInvoker with a terminal (T-D1)', () => {
  it('routes a flat-argument operation to the terminal: the caller gets its result, dispatch never runs', async () => {
    const controller = new AbortController();
    const received: Array<{ fnName: string; args: unknown; signal: unknown; routedBy: unknown }> = [];
    const terminal: Terminal = async (fnName, call) => {
      received.push({
        fnName,
        args: call.domainArgs,
        signal: call.signal,
        routedBy: call.operation.binding ?? call.operation.host,
      });
      return 'saved';
    };
    // Empty schemas AND a function that would answer "dispatched": either path leaving evidence proves dispatch ran.
    const result = await createInvoker([], { terminal })('notes/save', makeCall(controller.signal), {
      fns: { 'notes/save': dispatched },
      schemas: {},
    });
    expect(result).toBe('saved');
    expect(dispatched).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0].fnName).toBe('notes/save');
    expect(received[0].args).toEqual({ text: 'hi' }); // one flat object, not spread positionally
    expect(received[0].signal).toBe(controller.signal);
    expect(received[0].routedBy).toBe('mcp:notes');
  });

  it('runs layers around the terminal, outermost first, and hands the terminal what the layers left', async () => {
    const order: string[] = [];
    const tag = (name: string): Layer => async (call, next) => {
      order.push(`${name}:in`);
      call.domainArgs = { ...call.domainArgs, [name]: true };
      const r = await next();
      order.push(`${name}:out`);
      return r;
    };
    const terminal: Terminal = async (_f, call) => {
      order.push('terminal');
      return call.domainArgs;
    };
    const result = await createInvoker([tag('a'), tag('b')], { terminal })('notes/save', makeCall(), { fns: {}, schemas: {} });
    expect(order).toEqual(['a:in', 'b:in', 'terminal', 'b:out', 'a:out']);
    expect(result).toEqual({ text: 'hi', a: true, b: true });
  });

  it('a layer that short-circuits keeps the terminal from running', async () => {
    const terminal = vi.fn<Terminal>(async () => 'saved');
    const deny: Layer = async () => 'denied';
    expect(await createInvoker([deny], { terminal })('notes/save', makeCall(), { fns: {}, schemas: {} })).toBe('denied');
    expect(terminal).not.toHaveBeenCalled();
  });

  it('a terminal rejection propagates to the caller', async () => {
    const terminal: Terminal = async () => {
      throw new Error('upstream down');
    };
    await expect(createInvoker([], { terminal })('notes/save', makeCall(), { fns: {}, schemas: {} })).rejects.toThrow('upstream down');
  });

  it('a terminal may return a stream', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield 'a';
      yield 'b';
    }
    const result = (await createInvoker([], { terminal: async () => chunks() })('notes/save', makeCall(), {
      fns: {},
      schemas: {},
    })) as AsyncIterable<string>;
    const out: string[] = [];
    for await (const c of result) out.push(c);
    expect(out).toEqual(['a', 'b']);
  });
});

describe('createInvoker without a terminal (T-D1: dispatch path unchanged)', () => {
  const schemas: ComposedSchemas = {
    greet: {
      input: {
        type: 'object',
        properties: { data: { type: 'object', properties: { name: { type: 'string' } } } },
      },
      output: {},
    },
  };

  it('dispatches a TS operation exactly as before (golden call result)', async () => {
    const result = await createInvoker([])('greet', { ...makeCall(), operation: { id: 'greet' }, domainArgs: { name: 'Ada' } }, {
      fns: { greet: (name: unknown) => `hello ${String(name)}` },
      schemas,
    });
    expect(result).toBe('hello Ada');
  });

  it('still fails fast when the operation has no schema', async () => {
    await expect(createInvoker([])('missing', makeCall(), { fns: {}, schemas })).rejects.toThrow(
      /no schema found for operation "missing"/
    );
  });

  it('an explicit empty options bag behaves as no terminal', async () => {
    const result = await createInvoker([], {})('greet', { ...makeCall(), operation: { id: 'greet' }, domainArgs: { name: 'Bo' } }, {
      fns: { greet: (n: unknown) => `hi ${String(n)}` },
      schemas,
    });
    expect(result).toBe('hi Bo');
  });
});

describe('createPackageInvoker with a terminal (T-D1)', () => {
  const schemas: ComposedSchemas = {
    'notes/save': {
      input: {
        type: 'object',
        properties: {
          data: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        },
        required: ['data'],
      },
      output: {},
    },
  };

  it('the terminal result reaches the caller after the validate layer accepts the arguments', async () => {
    const terminal: Terminal = async (_f, call) => ({ saved: call.domainArgs });
    const invoke = createPackageInvoker(schemas, [], { terminal });
    const result = await invoke('notes/save', makeCall(), { fns: { 'notes/save': dispatched }, schemas });
    expect(result).toEqual({ saved: { text: 'hi' } });
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('invalid arguments are rejected before the terminal runs', async () => {
    const terminal = vi.fn<Terminal>(async () => 'saved');
    const invoke = createPackageInvoker(schemas, [], { terminal });
    await expect(
      invoke('notes/save', { ...makeCall(), domainArgs: { text: 5 } }, { fns: {}, schemas })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(terminal).not.toHaveBeenCalled();
  });
});
