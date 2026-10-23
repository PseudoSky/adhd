/**
 * `anthropic-tool-result.ts` - the model-visible `content` of an Anthropic `tool_result` block (R10 S1 P5).
 *
 * The engine stores a tool's result as the tool returned it. For an MCP tool that is the content array
 * `[{type:'text', text:'...'}]`. The adapter used to send `JSON.stringify(result)`, so the model read a JSON
 * document with the file text escaped inside it (`\n`, `\"`, `\r`), inflating every read-heavy turn and hiding
 * CRLF as two literal characters (backlog ae9d4022). This helper sends what the model should read:
 *
 * - an MCP array of ONLY text blocks -> one string, the non-empty block texts joined by `\n`, characters verbatim;
 * - an MCP array with any non-text block -> an array of Anthropic blocks: text as text, `image` (jpeg/png/gif/webp)
 *   as a base64 image block, every other block (audio, resource, resource_link, unsupported image type) as a text
 *   block holding that block's JSON, so nothing is dropped; empty text blocks are omitted (the API rejects them);
 * - a string -> itself; anything else (an engine tool's object/number/array) -> its JSON once;
 * - `undefined` -> `undefined`, the field is then absent from the body exactly as before.
 *
 * Pure: no I/O. The stored result, compaction and token accounting are untouched; this is wire-only.
 */
import { isMcpContentArray, mcpContentText, type IMcpContentBlock } from '../engine/tool-result-cap.js';

/** Image media types the Messages API accepts in a base64 image source. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** An Anthropic text block inside a `tool_result` content array. */
export interface IToolResultTextBlock {
  type: 'text';
  text: string;
}

/** An Anthropic base64 image block inside a `tool_result` content array. */
export interface IToolResultImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string };
}

/** The `content` of a `tool_result` block. */
export type ToolResultContent = string | Array<IToolResultTextBlock | IToolResultImageBlock>;

function toBlock(b: IMcpContentBlock): IToolResultTextBlock | IToolResultImageBlock | undefined {
  if (b.type === 'text') {
    const text = b['text'] as string;
    return text === '' ? undefined : { type: 'text', text };
  }
  if (b.type === 'image' && IMAGE_MEDIA_TYPES.has(b['mimeType'] as string)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: b['mimeType'] as IToolResultImageBlock['source']['media_type'],
        data: b['data'] as string,
      },
    };
  }
  return { type: 'text', text: JSON.stringify(b) };
}

/**
 * Maps a stored tool result to the `content` of an Anthropic `tool_result` block.
 *
 * @param result - the stored tool result (MCP content array, string, or any JSON value)
 * @returns the wire content, or `undefined` when the result has no JSON form (the field is then omitted)
 */
export function toToolResultContent(result: unknown): ToolResultContent | undefined {
  const text = mcpContentText(result);
  if (text !== undefined) return text;
  if (isMcpContentArray(result)) {
    return result.flatMap(b => {
      const block = toBlock(b);
      return block ? [block] : [];
    });
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}
