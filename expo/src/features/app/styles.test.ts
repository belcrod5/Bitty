import { appStylesByTheme } from "./styles";

test("pre-generates distinct standard and cyberpunk style sheets", () => {
  expect(appStylesByTheme.standard).not.toBe(appStylesByTheme.cyberpunk);
  expect(appStylesByTheme.standard.settingsScreen.backgroundColor).toBe("#f2f2f7");
  expect(appStylesByTheme.cyberpunk.settingsScreen.backgroundColor).toBe("#080d13");
  expect(appStylesByTheme.standard.appDrawerRoot.backgroundColor).toBe("#f8fafc");
  expect(appStylesByTheme.cyberpunk.appDrawerRoot.backgroundColor).toBe("#14232e");
  expect(appStylesByTheme.cyberpunk.chatScreenPopup.backgroundColor)
    .toBe(appStylesByTheme.cyberpunk.appDrawerRoot.backgroundColor);
  expect(appStylesByTheme.cyberpunk.chatHeaderPopup.backgroundColor)
    .toBe(appStylesByTheme.cyberpunk.appDrawerRoot.backgroundColor);
  expect(appStylesByTheme.cyberpunk.chatDirectoryModalCard.backgroundColor)
    .toBe(appStylesByTheme.cyberpunk.appDrawerRoot.backgroundColor);
  expect(appStylesByTheme.standard.chatScroll).not.toHaveProperty("backgroundColor");
  expect(appStylesByTheme.cyberpunk.chatScroll).not.toHaveProperty("backgroundColor");
  expect(appStylesByTheme.standard.popupMessagesSkeleton).not.toHaveProperty("backgroundColor");
  expect(appStylesByTheme.cyberpunk.popupMessagesSkeleton).not.toHaveProperty("backgroundColor");
  expect(appStylesByTheme.standard.chatBubbleText.fontSize).toBe(14);
  expect(appStylesByTheme.cyberpunk.chatBubbleText.fontSize).toBe(14);
  expect(appStylesByTheme.standard.chatInput.fontSize).toBe(15);
  expect(appStylesByTheme.cyberpunk.chatInput.fontSize).toBe(15);
  expect(appStylesByTheme.standard.chatInputWrapper.borderWidth).toBe(1);
  expect(appStylesByTheme.cyberpunk.chatInputWrapper.borderWidth).toBe(1);
});
