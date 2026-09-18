import { appStylesByTheme } from "./styles";

test("pre-generates distinct standard and high-legibility style sheets", () => {
  expect(appStylesByTheme.standard).not.toBe(appStylesByTheme.highLegibility);
  expect(appStylesByTheme.standard.settingsScreen.backgroundColor).toBe("#f2f2f7");
  expect(appStylesByTheme.highLegibility.settingsScreen.backgroundColor).toBe("#e2e8f0");
  expect(appStylesByTheme.standard.chatBubbleText.fontSize).toBe(14);
  expect(appStylesByTheme.highLegibility.chatBubbleText.fontSize).toBe(16);
  expect(appStylesByTheme.standard.chatInput.fontSize).toBe(15);
  expect(appStylesByTheme.highLegibility.chatInput.fontSize).toBe(17);
  expect(appStylesByTheme.standard.chatInputWrapper.borderWidth).toBe(1);
  expect(appStylesByTheme.highLegibility.chatInputWrapper.borderWidth).toBe(2);
});
