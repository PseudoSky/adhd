import path from "node:path";
import os from "node:os";
import { config as dotenvConfig } from "dotenv";

export function loadEnvHierarchy(cwd: string = process.cwd()): void {
    dotenvConfig({ path: path.join(os.homedir(), ".adhd", ".env") });
    dotenvConfig({ path: path.join(cwd, ".adhd", ".env"), override: true });
    dotenvConfig({ path: path.join(cwd, ".env"), override: true });
}
