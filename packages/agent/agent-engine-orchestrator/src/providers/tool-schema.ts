import { ToolError } from "../validation/errors.js";

import type { ToolDefinition } from "./types.js";

/**
 * Tool input-schema normalisation at the provider boundary (backlog 020307a5).
 *
 * The Anthropic Messages API rejects the WHOLE request with HTTP 400
 * (`tools.<n>.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top
 * level`) when any one tool's `input_schema` carries a top-level `oneOf` / `anyOf` / `allOf`. An
 * MCP server is free to publish such a schema (the apigen-generated backlog server's
 * `batch_action` has a 32-branch top-level `oneOf`), so one tool kills every request the agent
 * makes.
 *
 * {@link normalizeToolForWire} is the ONE function every adapter that needs it calls (anthropic,
 * openai-compatible, the claudecli bridge). It flattens the top-level combinator into a plain
 * object schema and carries the constraint in the tool description, the transformation the Claude
 * Code CLI applies (a port of its `Gms` / `vr` normaliser, installed binary 2.1.296; the golden
 * fixtures under `__tests__/fixtures/tool-schema/` are that CLI's real input and output):
 *
 *  - `properties`: the root's own properties, then each combinator branch's, first definition of a
 *    name wins; a branch that is only a local `$ref` (`#/$defs/x`, `#/definitions/x`) is resolved
 *    against the root; names that are not `^[a-zA-Z0-9_.-]{1,64}$` and non-object property schemas
 *    are dropped (the API's own property-name rule).
 *  - `required`: the root's `required` plus every `allOf` branch's `required` (those hold
 *    together), restricted to names that survived into `properties`. A `oneOf` / `anyOf` branch's
 *    `required` is NOT merged, because it only holds for that branch.
 *  - `$defs`, `definitions`, `$schema`, `additionalProperties`, `description`, `title` are carried;
 *    `additionalProperties` defaults to `true`, since the flattened object no longer pins the shape.
 *  - the description gets one `Input constraint: ...` paragraph appended.
 *
 * A schema with no top-level combinator is returned as the SAME object (no copy, no description
 * change), so the request bytes of every existing tool are unchanged. The input is never mutated,
 * and the output is a deterministic function of the input (a stable prompt-cache prefix). The
 * output carries no combinator, so normalising it again is the identity (idempotent).
 */

/** The JSON Schema keywords the API refuses at the top level of a tool input schema. */
export const TOP_LEVEL_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
type Combinator = (typeof TOP_LEVEL_COMBINATORS)[number];

/** Root keywords copied through unchanged, in the order they are emitted. */
const CARRIED_KEYWORDS = ["$defs", "definitions", "$schema", "additionalProperties", "description", "title"] as const;

const PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;
const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

type Schema = Record<string, unknown>;

/** What an adapter puts on the wire for one tool. */
export interface IWireTool {
    description: string;
    inputSchema: Schema;
}

/** `ToolError.data` of a tool schema that cannot be normalised. */
export interface IToolSchemaErrorData {
    kind: "tool_schema_unnormalizable";
    /** Position of the tool in the request's `tools` array. */
    toolIndex: number;
    toolName: string;
    combinators: string[];
}

function isPlainObject(v: unknown): v is Schema {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The combinator keywords present on a root schema, in {@link TOP_LEVEL_COMBINATORS} order. */
function combinatorsOf(schema: Schema): Combinator[] {
    return TOP_LEVEL_COMBINATORS.filter((k) => k in schema);
}

/** True when the schema has a top-level `oneOf` / `anyOf` / `allOf` (the API would reject it). */
export function hasTopLevelCombinator(schema: unknown): boolean {
    return isPlainObject(schema) && combinatorsOf(schema).length > 0;
}

/** A branch that is only a local `$ref` into the root's `$defs` / `definitions`, replaced by its target (else as is). */
function resolveLocalRef(branch: Schema, root: Schema): Schema {
    const ref = branch["$ref"];
    if (typeof ref !== "string") return branch;
    const m = LOCAL_REF.exec(ref);
    if (m === null) return branch;
    const table = root[m[1] as string];
    if (!isPlainObject(table)) return branch;
    const target = table[m[2] as string];
    return isPlainObject(target) ? target : branch;
}

function branchesOf(list: unknown[], root: Schema): Schema[] {
    return list.filter(isPlainObject).map((b) => resolveLocalRef(b, root));
}

/** The "(a, b)" group a branch contributes to the constraint note: its `required` names, else its property names. */
function groupOf(branch: Schema): string | null {
    const required = branch["required"];
    if (Array.isArray(required) && required.length > 0 && required.every((r) => typeof r === "string")) {
        return required.join(", ");
    }
    const props = branch["properties"];
    if (isPlainObject(props)) {
        const names = Object.keys(props);
        if (names.length > 0) return names.join(", ");
    }
    return null;
}

function constraintNote(present: readonly Combinator[], combinatorBranches: ReadonlyMap<Combinator, Schema[]>): string {
    if (!present.includes("oneOf") && !present.includes("anyOf")) {
        return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
    }
    const kind: "oneOf" | "anyOf" = present.includes("oneOf") ? "oneOf" : "anyOf";
    const lead = kind === "oneOf" ? "Provide parameters for exactly one of" : "Provide parameters for at least one of";
    const groups = [...new Set((combinatorBranches.get(kind) ?? []).map(groupOf).filter((g): g is string => g !== null))];
    if (groups.length === 0) {
        return `Input constraint: ${lead} the documented parameter groups (flattened from a JSON Schema ${kind}).`;
    }
    return `Input constraint: ${lead}: ${groups.map((g) => `(${g})`).join(" or ")}.`;
}

/**
 * Flattens a root schema with a top-level `oneOf` / `anyOf` / `allOf` into a plain object schema.
 *
 * @param schema a tool `inputSchema`
 * @returns `{ schema, note }` where `note` is the `Input constraint: ...` paragraph, or `undefined`
 *   with `schema` being the SAME object when there was nothing to flatten
 * @throws Error when a combinator is not an array, or the root declares a `type` other than `"object"`
 *   (such a schema has no defined meaning to flatten)
 */
export function flattenRootCombinators(schema: Schema): { schema: Schema; note?: string } {
    const present = combinatorsOf(schema);
    if (present.length === 0) return { schema };

    const rootType = schema["type"];
    if (rootType !== undefined && rootType !== "object") {
        throw new Error(`root type is ${JSON.stringify(rootType)}, not "object"`);
    }

    const branchesBy = new Map<Combinator, Schema[]>();
    for (const key of present) {
        const list = schema[key];
        if (!Array.isArray(list)) throw new Error(`top-level ${key} is not an array`);
        branchesBy.set(key, branchesOf(list, schema));
    }

    const properties: Schema = Object.create(null) as Schema;
    const take = (props: unknown): void => {
        if (!isPlainObject(props)) return;
        for (const [name, def] of Object.entries(props)) {
            if (PROPERTY_NAME.test(name) && !(name in properties) && isPlainObject(def)) properties[name] = def;
        }
    };
    take(schema["properties"]);
    for (const key of present) for (const branch of branchesBy.get(key) ?? []) take(branch["properties"]);

    const required = new Set<string>();
    const keep = (names: unknown): void => {
        if (!Array.isArray(names)) return;
        for (const n of names) if (typeof n === "string" && n in properties) required.add(n);
    };
    keep(schema["required"]);
    for (const branch of branchesBy.get("allOf") ?? []) keep(branch["required"]);

    const flat: Schema = { type: "object", properties: { ...properties }, required: [...required] };
    for (const key of CARRIED_KEYWORDS) if (key in schema) flat[key] = schema[key];
    if (!("additionalProperties" in schema)) flat["additionalProperties"] = true;

    return { schema: flat, note: constraintNote(present, branchesBy) };
}

/** `description` with the constraint paragraph appended (the note alone for an empty description). */
function appendNote(description: string, note: string | undefined): string {
    if (!note) return description;
    return description ? `${description}\n\n${note}` : note;
}

/**
 * The description and input schema ONE tool is sent with.
 *
 * @param tool the registered tool definition (never mutated)
 * @param index the tool's position in the request's `tools` array (the `n` of the API's `tools.<n>`)
 * @returns the wire description and schema; the registered `inputSchema` object itself when no
 *   normalisation is needed. A missing schema becomes the empty object schema.
 * @throws ToolError `PROVIDER_INVALID_REQUEST` naming `tools.<index>` and the tool when its
 *   schema has a top-level combinator that cannot be flattened. Thrown BEFORE any request is made,
 *   so it is never retried and the model call never starts.
 */
export function normalizeToolForWire(tool: ToolDefinition, index: number): IWireTool {
    const description = tool.description || "";
    const raw = (tool.inputSchema || { type: "object", properties: {} }) as Schema;
    if (!hasTopLevelCombinator(raw)) return { description, inputSchema: raw };

    const combinators = combinatorsOf(raw);
    try {
        const { schema, note } = flattenRootCombinators(raw);
        return { description: appendNote(description, note), inputSchema: schema };
    } catch (cause) {
        const data: IToolSchemaErrorData = { kind: "tool_schema_unnormalizable", toolIndex: index, toolName: tool.name, combinators };
        throw new ToolError(
            "PROVIDER_INVALID_REQUEST",
            `tools.${index} (${tool.name}): input schema uses top-level ${combinators.join("/")}, which the provider API rejects, ` +
                `and it could not be normalized: ${cause instanceof Error ? cause.message : String(cause)}`,
            data
        );
    }
}

/** {@link normalizeToolForWire} over a whole tool list, so an error carries the tool's real `tools.<n>` index. */
export function normalizeToolsForWire(tools: readonly ToolDefinition[]): Array<IWireTool & { name: string }> {
    return tools.map((tool, i) => ({ name: tool.name, ...normalizeToolForWire(tool, i) }));
}
