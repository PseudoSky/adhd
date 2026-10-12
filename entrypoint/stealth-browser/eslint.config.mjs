import baseConfig from "../../eslint.base.config.mjs";
import jsoncEslintParser from "jsonc-eslint-parser";

export default [
    ...baseConfig,
    {
        files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        rules: {}
    },
    {
        files: ["**/*.json"],
        rules: {
            "@nx/dependency-checks": [
                "error",
                {
                    ignoredFiles: [
                        "{projectRoot}/vite.config.{js,ts,mjs,mts}"
                    ],
                    // TEMPORARY(stealth-browser:deps-install): the parser sources land in
                    // mig-capture-parsers; that state removes this ignore (mig-capture-parsers.6).
                    ignoredDependencies: ["node-html-parser", "xpath", "@xmldom/xmldom"]
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
