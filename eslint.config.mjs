import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // react-hooks v7 的 React Compiler 顧問性規則：抓的是「effect 內同步 setState」
      // 這類行之有年的合法寫法(hydration guard、載入後寫回 state)，屬於為將來啟用
      // React Compiler 的最佳化建議，不是正確性問題——降回 warning，等導入 Compiler 時再逐步改。
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
