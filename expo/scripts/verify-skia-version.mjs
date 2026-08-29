import { readFileSync } from "node:fs";

const expectedVersion = "2.11.1";
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const actualVersion = packageJson.dependencies?.["@shopify/react-native-skia"];

if (actualVersion !== expectedVersion) {
  console.error(
    `[preinstall] @shopify/react-native-skia must remain ${expectedVersion}; ` +
      `found ${actualVersion ?? "no version"}. Check the upstream fix status ` +
      "and rerun the keyboard-open first-tap scenario on a real device before " +
      "updating this guard."
  );
  process.exit(1);
}
