import yaml from 'yaml';
import { PolicyLoadError } from '../../core';

/** Shape of a `yaml` 1.x document error that may carry a position. */
interface IYamlErrorLike {
  readonly message: string;
  readonly linePos?: { readonly start?: { readonly line?: number } };
  makePretty?: () => void;
}

/**
 * Parses YAML text to JSON-compatible data using the `yaml` package (strict:
 * duplicate keys are an error). Throws `PolicyLoadError('malformed',
 * "<source>: <parser message> (line N)")`. An empty document throws
 * `malformed` too: a layer file with no content is never silently an empty policy.
 */
export function parsePolicyYaml(text: string, source: string): unknown {
  const doc = yaml.parseDocument(text);
  const first = doc.errors[0] as IYamlErrorLike | undefined;
  if (first !== undefined) {
    first.makePretty?.();
    const line = first.linePos?.start?.line;
    const firstLine = first.message.split('\n')[0].replace(/[:\s]+$/, '');
    throw new PolicyLoadError(
      'malformed',
      `${source}: ${firstLine}${line === undefined || /\bline \d+/.test(firstLine) ? '' : ` (line ${line})`}`
    );
  }
  const value = doc.toJSON() as unknown;
  if (value === null || value === undefined) {
    throw new PolicyLoadError('malformed', `${source}: the file is empty; expected a policy document`);
  }
  return value;
}

/**
 * Deterministic YAML for drafts: block style, 2-space indent, keys in insertion
 * order.
 */
export function stringifyPolicyYaml(value: unknown): string {
  return yaml.stringify(value, { indent: 2 });
}
