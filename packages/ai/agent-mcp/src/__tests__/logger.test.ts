import { describe, expect, it, vi } from "vitest";

describe("logger", () => {
    it("logger module can be imported without throwing", async () => {
        const { logger } = await import("../logger.js");
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(typeof logger.error).toBe("function");
        expect(typeof logger.warn).toBe("function");
        expect(typeof logger.debug).toBe("function");
        expect(typeof logger.fatal).toBe("function");
    });

    it("logger writes to stderr (fd 2), not stdout", async () => {
        const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

        const { logger } = await import("../logger.js");
        logger.info("test log message");

        // Allow pino to flush
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(stdoutWriteSpy).not.toHaveBeenCalled();

        stderrWriteSpy.mockRestore();
        stdoutWriteSpy.mockRestore();
    });
});
