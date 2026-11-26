import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "quotes": ["warn", "double"],
      "indent": ["warn", 2, { "SwitchCase": 1 }],
      "semi": ["warn", "always"],
      "comma-dangle": "off",
      "dot-notation": "off",
      "eqeqeq": "warn",
      "curly": ["warn", "all"],
      "brace-style": ["warn"],
      "prefer-arrow-callback": ["warn"],
      "max-len": ["warn", 140],
      "no-console": ["warn"], // use the provided Homebridge log method instead
      "comma-spacing": ["error"],
      "no-multi-spaces": ["warn", { "ignoreEOLComments": true }],
      "lines-between-class-members": ["warn", "always", { "exceptAfterSingleLine": true }],
      // Relaxed to keep the pre-existing code style (typescript-eslint v8 recommended is stricter than v5).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
);
