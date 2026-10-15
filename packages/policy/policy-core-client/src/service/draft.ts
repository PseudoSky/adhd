import { compile } from '../core';
import { normalizeToolId } from '../core/compile/tool-ids';
import type {
  Effect,
  FilterExpression,
  IDraftOperation,
  IDraftOptions,
  IDraftPolicy,
  IInferredEntry,
  IPermission,
  IPolicyDocument,
} from '../spec';
import { stringifyPolicyYaml } from './config/yaml';

/**
 * The built-in secret-path list, written as LIKE-style patterns: `%` is any run
 * of characters and `_` is a LITERAL underscore (`id_rsa` means exactly that;
 * there is no single-character wildcard). Drafts compile each into an anchored
 * `_regex`; see {@link draftPolicy}.
 */
export const DEFAULT_SECRET_LIKE_PATTERNS: readonly string[] = [
  '%/.env',
  '%/.env.%',
  '%/.ssh/%',
  '%/.aws/%',
  '%id_rsa%',
  '%.pem',
];

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Converts a LIKE-style pattern to an anchored regular expression (`%` is any
 * run, `_` is literal). A leading `%/` also matches the bare name (`%/.env`
 * matches `.env` and `/a/.env`). The match also covers a trailing slash and
 * everything nested below a matched segment: `%/.env` matches `/x/.env/` and
 * `/x/.env/backup`, and a trailing `/%` also matches the directory itself
 * (`%/.ssh/%` matches `/home/u/.ssh`). The query engine's `_like` is a substring
 * test and cannot express "ends with", so the draft uses `_regex`.
 */
function likeToRegex(pattern: string): string {
  let rest = pattern;
  let prefix = '^';
  if (rest.startsWith('%/')) {
    prefix = '^(?:.*/)?';
    rest = rest.slice(2);
  }
  let suffix = '(?:/.*)?$';
  if (rest.endsWith('/%')) {
    rest = rest.slice(0, -2);
  } else if (rest.endsWith('%')) {
    suffix = '$';
  }
  const body = rest
    .split('%')
    .map((part) => escapeRegex(part))
    .join('.*');
  return `${prefix}${body}${suffix}`;
}

/** True when a declared argument type is a list/array of values (`string[]`, `Array<string>`, `list`, `Set<string>`, ...). */
const isListType = (type: string): boolean => /\[\]|^\s*(?:readonly\s+)?(?:array|readonlyarray|list|set|iterable)\b/i.test(type);

function effectFor(destructive: boolean, readOnly: boolean): Effect {
  if (destructive) return 'deny';
  return readOnly ? 'allow' : 'ask';
}

/**
 * D-09 / D-16. Pure and deterministic. Declares `read_roots` / `write_roots`
 * (kind `paths`) only when an operation needs them. One permission per
 * operation (input order): `tool` = the operation name as a `/` id (BA-5: a
 * name written with the pre-BA-5 `.` separator, `files.read`, is drafted as
 * `files/read`, so the draft never writes an id the loader rejects); effect `deny` when
 * destructive, `allow` when read-only, else `ask`. Each argument of kind `path`
 * on a non-denied operation gets `{ <arg>: { _within: '$attributes.<roots>' } }`;
 * `url` / `host` arguments get no constraint and an inferred note; a list-valued
 * path argument keeps its `_within` (which holds for every element) but is listed
 * as inferred because the secret-path deny does not look inside lists. Any argument
 * with provenance `inferred` or no kind produces an inferred entry. A leading
 * deny for `tool: '*'` rejects any path argument matching a secret pattern.
 * The result is asserted to compile with zero errors; a violation throws a plain
 * Error (it is a bug, not a user error).
 */
export function draftPolicy(input: {
  operations: readonly IDraftOperation[];
  options?: IDraftOptions;
}): IDraftPolicy {
  const options: IDraftOptions = input.options ?? { source: 'draft' };
  const readRoots = options.readRootsAttribute ?? 'read_roots';
  const writeRoots = options.writeRootsAttribute ?? 'write_roots';
  const patterns = options.secretPatterns ?? DEFAULT_SECRET_LIKE_PATTERNS;
  const inferred: IInferredEntry[] = [];
  const permissions: IPermission[] = [];
  const pathArgNames: string[] = [];
  let usesRead = false;
  let usesWrite = false;

  for (const operation of input.operations) {
    const tool = normalizeToolId(operation.name);
    const readOnly = operation.hints?.readOnly === true;
    const destructive = operation.hints?.destructive === true;
    const effect = effectFor(destructive, readOnly);
    const args: Record<string, unknown> = {};
    for (const arg of operation.args) {
      const kind = arg.kind;
      if (kind === 'path') {
        if (!pathArgNames.includes(arg.name)) pathArgNames.push(arg.name);
        if (isListType(arg.type)) {
          inferred.push({
            operation: tool,
            argument: arg.name,
            kind,
            reason: 'list-valued: not constrained, review (the secret-path deny matches a single path string, not each element of a list)',
          });
        }
        if (!destructive) {
          if (readOnly) usesRead = true;
          else usesWrite = true;
          args[arg.name] = { _within: `$attributes.${readOnly ? readRoots : writeRoots}` };
        }
      } else if (kind === 'url' || kind === 'host') {
        inferred.push({ operation: tool, argument: arg.name, kind, reason: 'no constraint drafted' });
      }
      if (arg.provenance === 'inferred' || kind === undefined) {
        inferred.push({
          operation: tool,
          argument: arg.name,
          kind: kind ?? 'unknown',
          reason:
            kind === undefined
              ? 'argument kind is not known; no constraint drafted'
              : 'argument kind was inferred, not declared; review it',
        });
      }
    }
    permissions.push({
      tool,
      effect,
      ...(Object.keys(args).length > 0 ? { args: args as FilterExpression } : {}),
    });
  }

  if (pathArgNames.length > 0 && patterns.length > 0) {
    const alternatives: FilterExpression[] = [];
    for (const name of pathArgNames) {
      for (const pattern of patterns) alternatives.push({ [name]: { _regex: likeToRegex(pattern) } });
    }
    permissions.unshift({ tool: '*', effect: 'deny', args: { _or: alternatives } });
  }

  const attributes: Record<string, 'paths'> = {};
  if (usesRead) attributes[readRoots] = 'paths';
  if (usesWrite) attributes[writeRoots] = 'paths';
  const document: IPolicyDocument = {
    version: 1,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    permissions,
  };

  const check = compile([{ name: 'project', source: options.source, document }]);
  if (!check.ok) {
    throw new Error(`draftPolicy produced a policy that does not compile (bug): ${check.errors.map((e) => e.message).join('; ')}`);
  }
  return { document, yaml: stringifyPolicyYaml(document), inferred };
}
