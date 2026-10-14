import { readFile as readFileFromDisk } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import type { Attributes } from '@adhd/policy-core-client';

/** Where the launcher gets the caller's attributes from on every call. */
export interface IAttributesSource {
  /** Resolves the attributes, or `undefined` when none are configured. Throws `ApiError('invalid_argument')` on a bad value. */
  read(): Promise<Attributes | undefined>;
  readonly origin: 'flag' | 'env' | 'none';
}

function isAttributeValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function parseAttributes(text: string, label: string): Attributes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ApiError('invalid_argument', `attributes: ${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('invalid_argument', `attributes: ${label} must be a JSON object`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAttributeValue(value)) {
      throw new ApiError('invalid_argument', `attributes: "${key}" must be a string, a number or a list of strings`);
    }
  }
  return parsed as Attributes;
}

/**
 * D-06: the flag value, else the environment value (`ADHD_POLICY_ATTRIBUTES`,
 * passed in by the caller; this file reads no `process.env`), else none. They
 * are never merged. A value starting with `@` is a file path read on EVERY
 * `read()`, so a rotating identity file is honoured. The JSON must be an object
 * whose values are string, number or string[]; otherwise `read()` throws
 * `ApiError('invalid_argument', 'attributes: ...')`.
 */
export function createAttributesSource(input: {
  flag?: string;
  env?: string;
  cwd: string;
  readFile?: (path: string) => Promise<string>;
}): IAttributesSource {
  const read = input.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'));
  const hasFlag = input.flag !== undefined && input.flag !== '';
  const hasEnv = input.env !== undefined && input.env !== '';
  let raw: string | undefined;
  let origin: IAttributesSource['origin'] = 'none';
  if (hasFlag) {
    raw = input.flag;
    origin = 'flag';
  } else if (hasEnv) {
    raw = input.env;
    origin = 'env';
  }
  return {
    origin,
    async read(): Promise<Attributes | undefined> {
      if (raw === undefined) return undefined;
      if (!raw.startsWith('@')) return parseAttributes(raw, 'value');
      const path = resolve(input.cwd, raw.slice(1));
      let text: string;
      try {
        text = await read(path);
      } catch (error) {
        throw new ApiError('invalid_argument', `attributes: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
      }
      return parseAttributes(text, path);
    },
  };
}
