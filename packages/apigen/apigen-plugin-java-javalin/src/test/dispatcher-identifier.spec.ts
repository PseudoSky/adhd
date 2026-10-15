// renderDispatcherJava — parameter names must be Java identifiers at generate time.
//
// Header (author-regression):
//   - item 6e29bff1 (fix pre-state 5a59f9ec): renderBranch spliced parameter names raw into
//     generated Java (`__p_<name>` locals and `body.get("<name>")` literals). A non-identifier
//     name produced a dispatcher that failed only at mvn time, and a quote or backslash could
//     break out of the string literal. AC: JAVA_IDENTIFIER
//     `/^[A-Za-z_$][A-Za-z0-9_$]*$/` accepts `_`, `$x`, `a1`; rejects `1a`, `a-b`, `a b`,
//     and the empty name; the error names the operation id.
//   - Failure mode: a bad parameter name is emitted into Java source, or the generator
//     accepts it silently.
//   - Tier: S (unit). renderDispatcherJava is a pure string renderer; no JVM, process, or
//     network is involved, so nothing is mocked.
//   - Fidelity-gap: N/A (tier S).
//   - regression:6e29bff1
//
// Keyword-adjacent names are NOT asserted: the identifier check does not reject Java
// keywords, and the brief says to assert only existing behavior.
// The accepts-cases are no-regression guards and pass before the fix; the rejects-cases are
// the regression assertions.

import { describe, it, expect } from 'vitest';
import type { Operation } from '@adhd/apigen-core-client';
import { renderDispatcherJava, type JavaOperation } from '../lib/dispatcher-template';

function seg(raw: string) {
  return { raw, words: [raw] };
}

/** One Java-extended operation with a single String parameter named `paramName`. */
function opWithParam(paramName: string, id = 'orders/create'): JavaOperation {
  const base: Operation = {
    id,
    host: 'java',
    namespace: seg('orders'),
    path: [seg('create')],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
  return {
    ...base,
    methodName: 'create',
    className: 'OrderApi',
    javaParams: [{ name: paramName, javaType: 'String' }],
    javaReturnType: 'void',
  };
}

describe('renderDispatcherJava parameter-name identifier check (6e29bff1)', () => {
  // Guards: these names are valid Java identifiers and must keep rendering.
  it.each(['_', '$x', 'a1'])(
    'accepts the valid identifier "%s" and emits it into the generated dispatcher',
    (name) => {
      const src = renderDispatcherJava([opWithParam(name)]);

      expect(src).toContain(`body.get("${name}")`);
      expect(src).toContain(`__p_${name}`);
    }
  );

  // Regression: each of these must be refused at generate time, not emitted into Java.
  // Pre-fix, renderDispatcherJava returned source containing the raw name.
  it.each(['1a', 'a-b', 'a b', ''])(
    'rejects the non-identifier parameter name %j at generate time',
    (name) => {
      expect(() => renderDispatcherJava([opWithParam(name)])).toThrow(
        /not a valid Java identifier/
      );
    }
  );

  // Regression: the error names the operation id so the failure is attributable to the op.
  it('the rejection error names the operation id and the offending parameter name', () => {
    expect(() =>
      renderDispatcherJava([opWithParam('a-b', 'orders/create')])
    ).toThrow(/operation "orders\/create".*parameter name "a-b"/);
  });

  // Regression: a quote or backslash must not reach the body.get("...") string literal,
  // which is the injection the check exists to stop.
  it.each(['a"b', 'a\\b'])(
    'rejects %j, which could otherwise break out of the body.get string literal',
    (name) => {
      expect(() => renderDispatcherJava([opWithParam(name)])).toThrow(
        /not a valid Java identifier/
      );
    }
  );
});
