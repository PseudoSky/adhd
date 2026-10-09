/**
 * Wire logging barrel (backlog c536ce29): the channel lifecycle plus the raw-call wrappers.
 * The wrappers take their channel as a parameter; wiring them into providers and MCP clients is
 * done by the host through `EngineConfig.wire`.
 */
export * from "./channels.js";
export { tracedFetch, redactUrl, DEFAULT_BODY_MAX_BYTES, type IWireOptions, type ChannelSource } from "./traced-fetch.js";
export { tracedSpawn } from "./traced-spawn.js";
export { TracedTransport, type ITransportMeta } from "./traced-transport.js";
export { withApiLog, withHttpApiLog, noteToolError } from "./api-log.js";
export { createWireSeams, getWireSeams, engineConfig } from "./seams.js";
