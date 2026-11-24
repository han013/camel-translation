import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
    {
        ignores: ["node_modules/**", ".vscode-test/**", "**/*.vsix"],
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": ["warn", { caughtErrors: "none" }],
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    },
    {
        files: ["test/extension.test.js"],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
    prettier,
];
