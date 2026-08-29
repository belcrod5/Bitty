const { readFileSync } = jest.requireActual<typeof import("node:fs")>("node:fs");

const fabricBundles = [
  "ReactFabric-dev.js",
  "ReactFabric-prod.js",
  "ReactFabric-profiling.js",
];

it.each(fabricBundles)("uses remaining touches after batched cancellation in %s", (bundle) => {
  const source = readFileSync(
    `${process.cwd()}/node_modules/react-native/Libraries/Renderer/implementations/${bundle}`,
    "utf8"
  );

  expect(source).not.toContain("trackedTouchCount += 1");
  expect(source).not.toContain("--trackedTouchCount");
  expect(
    source.match(/trackedTouchCount = nativeEvent\.touches\.length/g)
  ).toHaveLength(2);
});
