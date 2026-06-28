import pino from "pino";
import { config } from "./config.js";

/**
 * Application logger.
 *
 * CRITICAL: All output goes to fd 2 (stderr).
 * When TRANSPORT=stdio, stdout is the MCP JSON-RPC stream — any write
 * to stdout would corrupt the framing. Never use console.log or pino's
 * default stdout destination.
 */
export const logger = pino(
    {
        level: config.logging.level,
        // Remove default `pid` and `hostname` fields for cleaner structured logs.
        base: undefined,
    },
    // Bind explicitly to fd 2 (stderr).
    pino.destination(2)
);
