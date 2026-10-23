/**
 * Test fixture (backlog 020307a5): how an LLM API treats a tool whose input schema has a top-level
 * `oneOf` / `anyOf` / `allOf`. Used by the unit tests (a `fetch` seam) and by the e2e test (a real
 * loopback HTTP server) so both reject exactly what the API rejects.
 *
 *  - {@link anthropicRootCombinatorRejection}: the Anthropic Messages API answer, byte for byte the
 *    R11 capture (parity run R11, task 9d4ba03c): HTTP 400 `invalid_request_error`,
 *    `tools.<n>.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`.
 *  - {@link openaiRootCombinatorRejection}: the OpenAI-style answer for a function whose `parameters`
 *    root is a combinator. This one encodes the rule as REPORTED by OpenAI-hosted endpoints (their
 *    error text: "schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at
 *    the top level"); it was NOT checked against a live endpoint (paid calls are out of scope) and
 *    DeepSeek's behaviour is unrecorded. It makes the negative control for the openai adapter concrete.
 */
const COMBINATORS = ["oneOf", "allOf", "anyOf"] as const;

/** The first top-level combinator keyword of a JSON Schema, if any. */
export function rootCombinatorOf(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  return COMBINATORS.find((k) => k in (schema as Record<string, unknown>));
}

export interface IFakeApiRejection {
  status: 400;
  body: { type: "error"; error: { type: "invalid_request_error"; message: string } } | { error: Record<string, unknown> };
}

/** Anthropic: HTTP 400 when any `tools[i].input_schema` has a root combinator, else `undefined`. */
export function anthropicRootCombinatorRejection(body: { tools?: Array<{ input_schema?: unknown }> }): IFakeApiRejection | undefined {
  const tools = body.tools ?? [];
  for (let i = 0; i < tools.length; i++) {
    if (rootCombinatorOf(tools[i]?.input_schema) !== undefined) {
      return {
        status: 400,
        body: {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `tools.${i}.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`,
          },
        },
      };
    }
  }
  return undefined;
}

/** OpenAI-compatible: HTTP 400 when any `tools[i].function.parameters` has a root combinator, else `undefined`. */
export function openaiRootCombinatorRejection(body: { tools?: Array<{ function?: { name?: string; parameters?: unknown } }> }): IFakeApiRejection | undefined {
  const tools = body.tools ?? [];
  for (let i = 0; i < tools.length; i++) {
    const fn = tools[i]?.function;
    if (rootCombinatorOf(fn?.parameters) !== undefined) {
      return {
        status: 400,
        body: {
          error: {
            message: `Invalid schema for function '${fn?.name}': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.`,
            type: "invalid_request_error",
            param: `tools[${i}].function.parameters`,
            code: "invalid_function_parameters",
          },
        },
      };
    }
  }
  return undefined;
}
