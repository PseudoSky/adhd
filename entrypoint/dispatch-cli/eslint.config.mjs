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
            //
            // `better-sqlite3` is a TEST-SUPPORT-ONLY import: the guarded live runner
            // (`src/test/integration/run-live-guarded.ts`) reads the spawned agent-mcp's
            // real `task_usage`/`messages` telemetry to enforce the cost/turn/message
            // guards. It is a non-spec `src/test/**` script (so it is outside the
            // build's `tsconfig.lib.json`), but is NOT a `.spec`/`.test` file (so the
            // dependency analyzer's test-file exclusion misses it). It must NOT be a
            // runtime `dependency` of the published package — the shipped `dist` never
            // imports it — so it belongs on the ignore list, not in `dependencies`.
            // (`live-dispatch-five-acs.e2e.test.ts` imports it too, but as a `.test.ts`
            // it is excluded from the check.)
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    ignoredDependencies: [
                        "@adhd/backlog",
                        "@modelcontextprotocol/sdk",
                        "better-sqlite3"
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
