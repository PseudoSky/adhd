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
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    ignoredDependencies: [
                        "@adhd/agent-plugin-budget",
                        "@adhd/agent-plugin-tracing"
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
