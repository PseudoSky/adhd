import pino from "pino";
import { env } from "./config.js";

export const logger = pino(
    {
        level: env.config.logging.level,
        base: undefined,
    },
    pino.destination(2)
);
