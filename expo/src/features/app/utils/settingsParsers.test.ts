import { parseModelRef } from "./settingsParsers";

test("keeps a persisted provider model opaque until the backend catalog arrives", () => {
  expect(parseModelRef("sonnet", [], "gpt-5.6-sol")).toBe("sonnet");
});
