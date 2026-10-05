import baseConfig from "../../../eslint.base.config.mjs";
import jsoncEslintParser from "jsonc-eslint-parser";

export default [
    ...baseConfig,
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx"
        ],
        rules: {
            "@typescript-eslint/no-empty-function": "off"
        }
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx"
        ],
        // Override or add rules here
        rules: {}
    },
    {
        files: [
            "**/*.js",
            "**/*.jsx"
        ],
        // Override or add rules here
        rules: {}
    },
    {
        files: [
            "**/*.json"
        ],
        rules: {
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    ignoredDependencies: [
                        // Resolved dynamically by the plugin loader from a bare
                        // specifier — external plugins are host dependencies and
                        // are never statically imported. Declared as an optional
                        // peer so the loader's own-module resolution base finds
                        // it. See plugins/loader.ts and backlog dfb03557.
                        "@adhd/agent-plugin-budget",
                        "tslib",
                        "better-sqlite3",
                        "@anthropic-ai/sdk",
                        "openai",
                        "p-queue",
                        "p-retry"
                    ]
                }
            ]
        },
        languageOptions: {
            parser: jsoncEslintParser
        }
    },
    {
        ignores: [
            "**/vite.config.js",
            "**/vite.config.ts",
            "**/vite.config.mjs",
            "**/vite.config.mts"
        ]
    }
];
