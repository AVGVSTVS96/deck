import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 140,
  ignorePatterns: [".agents/**", ".claude/**", "tools/oxlint/anti-slop/**"],
});
