let mockPlatform = "macos";
let mockCxxNativeAnimatedEnabled = false;
const mockLegacyAnimated = { name: "NativeAnimatedModule" };
const mockTurboAnimated = { name: "NativeAnimatedTurboModule" };
const mockGetNativeModule = jest.fn((name: string) =>
  name === "NativeAnimatedTurboModule" ? mockTurboAnimated : mockLegacyAnimated);

jest.mock("react-native-macos/Libraries/Utilities/Platform", () => ({
  __esModule: true,
  default: { get OS() { return mockPlatform; } },
}));
jest.mock("react-native-macos/Libraries/Utilities/Platform.ios", () => ({
  __esModule: true,
  default: { get OS() { return mockPlatform; } },
}));
jest.mock("react-native-macos/src/private/featureflags/ReactNativeFeatureFlags", () => ({
  cxxNativeAnimatedEnabled: () => mockCxxNativeAnimatedEnabled,
}));
jest.mock("react-native-macos/Libraries/TurboModule/TurboModuleRegistry", () => ({
  get: mockGetNativeModule,
}));

const runtime = globalThis as typeof globalThis & { RN$Bridgeless?: boolean };
const originalBridgeless = runtime.RN$Bridgeless;

afterEach(() => {
  runtime.RN$Bridgeless = originalBridgeless;
});

test.each([
  ["macos", true, false, "NativeAnimatedTurboModule"],
  ["ios", true, false, "NativeAnimatedTurboModule"],
  ["macos", false, false, "NativeAnimatedModule"],
  ["ios", false, false, "NativeAnimatedModule"],
  ["android", true, false, "NativeAnimatedModule"],
  ["android", false, false, "NativeAnimatedModule"],
  ["macos", true, true, "NativeAnimatedModule"],
  ["ios", true, true, "NativeAnimatedModule"],
])("selects %s bridgeless=%s C++=%s's compatible native animation module", (platform, bridgeless, cxx, expected) => {
  mockPlatform = platform;
  mockCxxNativeAnimatedEnabled = cxx;
  runtime.RN$Bridgeless = bridgeless;
  mockGetNativeModule.mockClear();

  jest.isolateModules(() => {
    const legacy = require("react-native-macos/Libraries/Animated/NativeAnimatedModule").default;
    const turbo = require("react-native-macos/Libraries/Animated/NativeAnimatedTurboModule").default;
    expect(legacy ?? turbo).toBe(expected === "NativeAnimatedTurboModule" ? mockTurboAnimated : mockLegacyAnimated);
    expect(mockGetNativeModule).toHaveBeenCalledTimes(1);
    expect(mockGetNativeModule).toHaveBeenCalledWith(expected);
  });
});
