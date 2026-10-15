/**
 * cli-logger.spec.ts — `cliLogger()` (server.ts) routes the one-shot CLI's
 * apigen-plugin-cli-output trace lines into sox-telemetry's log channel and
 * never onto stdout/stderr.
 *
 * Failure mode this guards: `@adhd/apigen-plugin-cli-output` falls back to its
 * own pino logger (info, JSON, stderr) whenever `input.logger` is absent, so
 * every `backlog <verb>` invocation printed `{"level":30,...,"msg":"→ backlog
 * query"}` and polluted any `2>&1` pipe. RED: with the pino fallback restored
 * (or `cliLogger` returning `undefined`), the stderr-spy and sox-routing
 * assertions below fail. GREEN: records arrive as `log.<level>('backlog.cli.log',
 * …)` and the process streams stay untouched.
 *
 * guards: the CLI logger writes apigen trace records to stdout or stderr, drops the sox routing or the level threshold, or garbles a message-only call into character-indexed fields.
 * tier: S
 * cites: be8b3b0c-86a9-4f51-a208-683838ae70e6 (CLI apigen trace routed to sox telemetry, not stderr).
 * The sox `log` channel is mocked because it is the external output boundary; `cliLogger` itself is the real code under test. `VITEST` is unset for the body of each case because `testSilentLogger` deliberately short-circuits to a no-op under vitest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@adhd/sox-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adhd/sox-telemetry')>()),
  log: logMock,
}));

import { cliLogger } from './server.js';

describe('cliLogger (CLI apigen logger → sox-telemetry)', () => {
  let savedVitest: string | undefined;
  let savedLevel: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedVitest = process.env['VITEST'];
    savedLevel = process.env['ADHD_BACKLOG_LOG_LEVEL'];
    delete process.env['VITEST'];
    delete process.env['ADHD_BACKLOG_LOG_LEVEL'];
    logMock.debug.mockClear();
    logMock.info.mockClear();
    logMock.warn.mockClear();
    logMock.error.mockClear();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (savedVitest === undefined) delete process.env['VITEST'];
    else process.env['VITEST'] = savedVitest;
    if (savedLevel === undefined) delete process.env['ADHD_BACKLOG_LOG_LEVEL'];
    else process.env['ADHD_BACKLOG_LOG_LEVEL'] = savedLevel;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  type PinoLike = {
    trace(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
    child(): PinoLike;
  };

  it('routes info to log.info under the backlog.cli.log event with command/ms/msg', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'backlog query', ms: 12 }, '→ backlog query');

    expect(logMock.info).toHaveBeenCalledTimes(1);
    expect(logMock.info).toHaveBeenCalledWith('backlog.cli.log', {
      command: 'backlog query',
      ms: 12,
      cliLevel: 'info',
      msg: '→ backlog query',
    });
  });

  it('keeps a stream-clean contract: nothing is written to stdout or stderr', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'backlog get', ms: 3 }, '→ backlog get');
    logger.error({ command: 'backlog get', code: 'internal', message: 'x' }, '✗ backlog get');

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('a message-only call (logger.info(msg), the apigen run.ts:605 shape) carries the message, not character-indexed fields', () => {
    const logger = cliLogger() as unknown as { info(msg: string): void };
    logger.info('cli run: signal already aborted before dispatch — skipping');

    expect(logMock.info).toHaveBeenCalledWith('backlog.cli.log', {
      cliLevel: 'info',
      msg: 'cli run: signal already aborted before dispatch — skipping',
    });
  });

  it('a trace call goes to log.debug with cliLevel "trace" and no `level` field that would replace the sink level', () => {
    process.env['ADHD_BACKLOG_LOG_LEVEL'] = 'trace';
    const logger = cliLogger() as unknown as PinoLike;
    logger.trace({ command: 'c' }, 't');

    expect(logMock.debug).toHaveBeenCalledTimes(1);
    const fields = logMock.debug.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toEqual({ command: 'c', cliLevel: 'trace', msg: 't' });
    expect('level' in fields).toBe(false);
  });

  it('maps warn and error to their sox levels', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.warn({ command: 'c' }, 'w');
    logger.error({ command: 'c' }, 'e');

    expect(logMock.warn).toHaveBeenCalledWith('backlog.cli.log', { command: 'c', cliLevel: 'warn', msg: 'w' });
    expect(logMock.error).toHaveBeenCalledWith('backlog.cli.log', { command: 'c', cliLevel: 'error', msg: 'e' });
  });

  it('default threshold is info: debug is dropped, info passes', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.debug({ chunk: 1 }, 'chunk 1');
    logger.info({ command: 'c' }, 'i');

    expect(logMock.debug).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledTimes(1);
  });

  it('ADHD_BACKLOG_LOG_LEVEL=silent drops every record', () => {
    process.env['ADHD_BACKLOG_LOG_LEVEL'] = 'silent';
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'c' }, 'i');
    logger.error({ command: 'c' }, 'e');

    expect(logMock.info).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('ADHD_BACKLOG_LOG_LEVEL=warn drops info but keeps error', () => {
    process.env['ADHD_BACKLOG_LOG_LEVEL'] = 'warn';
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'c' }, 'i');
    logger.error({ command: 'c' }, 'e');

    expect(logMock.info).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });

  it('an unrecognised ADHD_BACKLOG_LOG_LEVEL falls back to info', () => {
    process.env['ADHD_BACKLOG_LOG_LEVEL'] = 'loud';
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'c' }, 'i');

    expect(logMock.info).toHaveBeenCalledTimes(1);
  });

  it('serialises an Error under `err` to name/message/stack so the sox record keeps the stack', () => {
    const logger = cliLogger() as unknown as PinoLike;
    const boom = new TypeError('boom');
    logger.error({ command: 'c', err: boom }, '✗ c');

    const fields = logMock.error.mock.calls[0]?.[1] as { err: { name: string; message: string; stack: string } };
    expect(fields.err.name).toBe('TypeError');
    expect(fields.err.message).toBe('boom');
    expect(fields.err.stack).toContain('boom');
  });

  it('child() returns a logger with the same routing', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.child().info({ command: 'c' }, 'via child');

    expect(logMock.info).toHaveBeenCalledWith('backlog.cli.log', { command: 'c', cliLevel: 'info', msg: 'via child' });
  });

  it('child(bindings) merges its bindings into every record the child emits', () => {
    const logger = cliLogger() as unknown as { child(b: Record<string, unknown>): PinoLike };
    logger.child({ session: 'S1' }).info({ command: 'c' }, 'bound');

    expect(logMock.info).toHaveBeenCalledWith('backlog.cli.log', {
      session: 'S1',
      command: 'c',
      cliLevel: 'info',
      msg: 'bound',
    });
  });

  it('logger.info(fields) with no message keeps a msg already in the fields', () => {
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'c', msg: 'from fields' }, undefined as unknown as string);

    expect(logMock.info).toHaveBeenCalledWith('backlog.cli.log', {
      command: 'c',
      cliLevel: 'info',
      msg: 'from fields',
    });
  });

  it('error(err) with a bare Error carries its message and stack under err', () => {
    const logger = cliLogger() as unknown as { error(e: Error): void };
    logger.error(new RangeError('out of range'));

    const fields = logMock.error.mock.calls[0]?.[1] as { msg: string; err: { name: string; stack: string } };
    expect(fields.msg).toBe('out of range');
    expect(fields.err.name).toBe('RangeError');
    expect(fields.err.stack).toContain('out of range');
  });

  it('under vitest it defers to the silent no-op (VITEST set)', () => {
    process.env['VITEST'] = 'true';
    const logger = cliLogger() as unknown as PinoLike;
    logger.info({ command: 'c' }, 'i');

    expect(logMock.info).not.toHaveBeenCalled();
  });
});
