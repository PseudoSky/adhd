import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",

    schema: "./src/db/schema.ts",

    out: "./drizzle",

    dbCredentials: {
        url: process.env["REGISTRY_DATABASE_PATH"] || process.env["DATABASE_PATH"] || "./data/registry.db"
    },

    verbose: true,

    strict: true
});
