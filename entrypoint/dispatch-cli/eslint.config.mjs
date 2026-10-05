import baseConfig from "../../eslint.base.config.mjs";
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
        // Override or add rules here
        rules: {}
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
            // `@adhd/backlog` is a REAL runtime dependency: resolveBacklogMcpEntry()
            // locates its MCP entry at runtime via
            // `createRequire(...).resolve('@adhd/backlog')` — a dynamic require, not
            // a static import — so @nx/dependency-checks cannot see the usage and
            // would otherwise flag the declaration as obsolete. Ignoring it keeps the
            // declaration (needed so a published/installed dispatch-cli resolves the
            // backlog server out of the box) without a false "unused dependency"
            // error. Same rationale as the already-ignored @modelcontextprotocol/sdk.
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    ignoredDependencies: [
                        "@adhd/backlog",
                        "@modelcontextprotocol/sdk"
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
