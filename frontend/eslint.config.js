import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The `[object Object]` class: a FastAPI 422 `detail` is an ARRAY,
      // not a string. `x.detail as string` is a cast-lie tsc can't see;
      // rendering/throwing it produces "[object Object]" — an
      // unrecoverable blob for the user. Editor-time guard for the most
      // common reintroduction; the comprehensive CI net (both cast
      // shapes) lives in src/__tests__/errorDetail.test.ts.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression[typeAnnotation.type='TSStringKeyword'] > MemberExpression[property.name='detail']",
          message:
            "Don't cast `.detail as string` — a 422 detail is an array (renders as [object Object]). Route error bodies through formatErrorDetail() in src/api/errorDetail.ts.",
        },
      ],
    },
  },
);
