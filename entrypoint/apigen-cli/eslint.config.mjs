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
            "**/src/test/fixtures/**"
        ],
        rules: {
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "@nx/dependency-checks": "off"
        }
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
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}",
                        "{projectRoot}/src/test/fixtures/**"
                    ],
                    ignoredDependencies: [
                        "ts-morph",
                        "ts-json-schema-generator",
                        "@modelcontextprotocol/sdk",
                        "fastify",
                        "express",
                        "tsx",
                        "pino",
                        "pino-pretty",
                        "pino-http",
                        "thread-stream",
                        "sonic-boom"
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
            "**/vite.config.mts",
            "**/src/test/fixtures/**/**"
        ]
    }
];
