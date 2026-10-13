import { transformFileSync } from "@babel/core";
import { runInNewContext } from "node:vm";

describe("native Markdown image contract in Metro", () => {
  it.each(["src", "lib/module"])("registers image props and events in the %s native spec", (directory) => {
    const filename = require.resolve(`react-native-enriched-markdown/${directory}/EnrichedMarkdownNativeComponent.ts`);
    const result = transformFileSync(filename, {
      babelrc: false,
      configFile: false,
      presets: [require.resolve("@react-native/babel-preset")],
    });
    const exports: Record<string, any> = {};
    runInNewContext(result!.code!, {
      exports,
      require: (name: string) => {
        if (name === "react-native") return {};
        if (name === "react-native/Libraries/NativeComponent/NativeComponentRegistry") {
          return { get: (_name: string, config: () => unknown) => config() };
        }
        if (name === "react-native/Libraries/NativeComponent/ViewConfigIgnore") {
          return { ConditionallyIgnoredEventHandlers: (handlers: unknown) => handlers };
        }
        throw new Error(`Unexpected generated runtime dependency: ${name}`);
      },
    });
    const config = exports.__INTERNAL_VIEW_CONFIG;
    expect(config.validAttributes.resolveImages).toBe(true);
    expect(config.validAttributes.imageSources).toBe(true);
    expect(config.validAttributes.onImageSources).toBe(true);
    expect(config.directEventTypes.topImageSources.registrationName).toBe("onImageSources");
  });
});
