import baseConfig from "../../eslint.base.config.mjs";
import jsoncEslintParser from "jsonc-eslint-parser";

export default [
    ...baseConfig,
    // PARITY-INSTRUMENT-ONLY: parity/ is a private, unpublished measurement instrument
    // (plain .mjs, not in tsconfig.lib.json, not in the build copy list, not in package.json
    // `files`). Frozen goldens and dryrun fakes are not linted; the instrument keeps the
    // correctness rules but not the style rules its faithful round-4 port predates.
    { ignores: ["**/parity/golden/**", "**/parity/dryrun/**"] },
    {
        files: ["**/parity/**/*.mjs"],
        rules: {
            "no-useless-escape": "off",
            "no-empty": "off",
            "no-empty-function": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "no-control-regex": "off",
            "no-cond-assign": "off",
            "prefer-const": "off",
        },
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx"
        ],
        rules: {
            "@nx/enforce-module-boundaries": [
                "error",
                {
                    enforceBuildableLibDependency: false,
                    allow: [],
                    depConstraints: [
                        {
                            sourceTag: "*",
                            onlyDependOnLibsWithTags: [
                                "*"
                            ]
                        }
                    ]
                }
            ],
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_"
                }
            ]
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
                    // Build-only tooling: esbuild (devDependency) is used by the bundler
                    // script, which is never shipped to consumers. Declaring it as a
                    // runtime dependency would ship the esbuild binary with every install.
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}",
                        "{projectRoot}/scripts/bundle.mjs"
                    ],
                    ignoredDependencies: [
                        // Inlined into dist/bundle/*.js by scripts/bundle.mjs (esbuild), so they are
                        // declared as devDependencies and never ship. The rule reads the src imports
                        // and would otherwise demand them under `dependencies`.
                        "@adhd/agent-base-types",
                        "@adhd/agent-core-env",
                        "@adhd/agent-core-native-tooling",
                        "@adhd/agent-core-provider",
                        "@adhd/agent-engine-compiler",
                        "@adhd/agent-engine-orchestrator",
                        "@adhd/agent-store-prompts",
                        "@adhd/agent-store-runtime",
                        "@adhd/environment",
                        "@adhd/environment-base-spec",
                        "@modelcontextprotocol/sdk",
                        "@adhd/agent-plugin-budget",
                        "@adhd/agent-plugin-tracing",
                        "dotenv",
                        "drizzle-orm",
                        "pino",
                        "tslib",
                        "zod",
                        // Resolved by name at runtime (createRequire + require.resolve in
                        // @adhd/agent-core-native-tooling), not imported, so static analysis
                        // reports it unused. It must ship as a runtime dependency: the
                        // bundled server locates it next to the installed package.
                        "@modelcontextprotocol/server-filesystem"
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
