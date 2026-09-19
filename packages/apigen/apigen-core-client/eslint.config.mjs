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
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    ignoredDependencies: [
                        "zod",
                        "decimal.js"
                    ]
                }
            ]
        },
        languageOptions: {
            parser: jsoncEslintParser
        }
    },
    {
        files: [
            "**/src/test/fixtures/**/*.ts"
        ],
        rules: {
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-unused-vars": "off"
        }
    },
    {
        ignores: [
            "**/vite.config.js",
            "**/vite.config.*",
            "**/vite.config.mjs",
            "**/vite.config.mts"
        ]
    }
];
