import { readFileSync } from "node:fs";

test("keeps the visual theme around the modal host and app providers", () => {
  const source = readFileSync(`${__dirname}/AppRoot.tsx`, "utf8");
  const providerStart = source.lastIndexOf("<VisualThemeProvider");
  const modalHostStart = source.lastIndexOf("<AppModalHost>");
  const appProvidersStart = source.lastIndexOf("<AppProviders");
  const appProvidersEnd = source.lastIndexOf("</AppProviders>");
  const modalHostEnd = source.lastIndexOf("</AppModalHost>");
  const providerEnd = source.lastIndexOf("</VisualThemeProvider>");

  expect(providerStart).toBeGreaterThan(-1);
  expect(providerStart).toBeLessThan(modalHostStart);
  expect(modalHostStart).toBeLessThan(appProvidersStart);
  expect(appProvidersStart).toBeLessThan(appProvidersEnd);
  expect(appProvidersEnd).toBeLessThan(modalHostEnd);
  expect(modalHostEnd).toBeLessThan(providerEnd);
});

test("leaves modal host ownership in AppRoot", () => {
  const entrySource = readFileSync(`${__dirname}/../../../App.tsx`, "utf8");
  expect(entrySource).not.toContain("AppModalHost");
});
