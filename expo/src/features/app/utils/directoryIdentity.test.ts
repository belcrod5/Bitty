import { reconcileRegisteredDirectories } from "./directoryIdentity";

describe("reconcileRegisteredDirectories", () => {
  it("replaces paths with canonical identities while preserving metadata", () => {
    const result = reconcileRegisteredDirectories([
      { id: "root", path: "/workspace/bitty", displayName: "Bitty", markerColor: "gray" },
    ], new Map([["/workspace/bitty", "."]]));

    expect(result.directories).toEqual([
      { id: "root", path: ".", displayName: "Bitty", markerColor: "gray" },
    ]);
    expect(result.removedIds).toEqual([]);
  });

  it("keeps the first id and preserves custom metadata from its duplicate", () => {
    const result = reconcileRegisteredDirectories([
      { id: "existing", path: ".", displayName: ".", markerColor: "gray" },
      { id: "duplicate", path: "/workspace/bitty", displayName: "Custom", markerColor: "red" },
    ], new Map([["/workspace/bitty", "."]]));

    expect(result.directories).toEqual([
      { id: "existing", path: ".", displayName: "Custom", markerColor: "red" },
    ]);
    expect(result.removedIds).toEqual(["duplicate"]);
    expect(result.retainedIdByRemovedId).toEqual(new Map([["duplicate", "existing"]]));
  });

  it("detects default metadata using the original path before canonicalization", () => {
    const result = reconcileRegisteredDirectories([
      { id: "absolute", path: "/workspace/bitty", displayName: "bitty", markerColor: "gray" },
      { id: "relative", path: ".", displayName: "Custom", markerColor: "yellow" },
    ], new Map([["/workspace/bitty", "."]]));

    expect(result.directories[0]).toEqual({
      id: "absolute",
      path: ".",
      displayName: "Custom",
      markerColor: "yellow",
    });
  });
});
