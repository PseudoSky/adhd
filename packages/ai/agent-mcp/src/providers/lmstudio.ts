import type { ProviderConfig } from "../validation/index.js";
import { OpenAIProvider } from "./openai.js";

export class LMStudioProvider extends OpenAIProvider {
    constructor(config: Extract<ProviderConfig, { type: "lmstudio" }>) {
        // LM Studio speaks the OpenAI API — reuse OpenAIProvider with a cast.
        // The local server doesn't require an API key, so we default to a
        // placeholder value to avoid OpenAI SDK complaints.
        super({
            ...config,
            type: "openai",
            baseURL: config.baseURL ?? process.env["LMSTUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
            apiKeyEnv: config.apiKeyEnv ?? "LMSTUDIO_API_KEY",
        });
    }
}
