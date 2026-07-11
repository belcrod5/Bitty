import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

// The real @expo/vector-icons module pulls in expo-font -> expo-asset, which is not
// hoisted to a resolvable path under this workspace's node_modules layout. GitDiffPanel
// only uses Ionicons for decorative icons, so a lightweight stub keeps this test focused
// on the lazy-mount / tree-collapse behavior under test without pulling in unrelated
// native module wiring.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Ionicons: (props: Record<string, unknown>) => React.createElement(Text, props, "icon"),
  };
});

import { GitDiffPanel } from "./GitDiffPanel";

function panelProps(overrides: Partial<React.ComponentProps<typeof GitDiffPanel>> = {}) {
  const props: React.ComponentProps<typeof GitDiffPanel> = {
    visible: false,
    runnerUrl: "http://localhost:8787",
    runnerToken: "token",
    selectedDirectoryPath: "/work/bitty",
    selectedDirectoryDisplayName: "Bitty",
    gitBranchName: "main",
    gitBranches: [],
    gitChangedFilesStaged: [],
    gitChangedFilesUnstaged: [],
    gitChangedFilesLoading: false,
    gitChangedFilesError: "",
    onRequestClose: jest.fn(),
    onRefreshGitChangedFiles: jest.fn(),
    showInfoToast: jest.fn(),
    onOpenMedia: jest.fn(),
    ...overrides,
  };
  return props;
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof GitDiffPanel>> = {}) {
  return render(<GitDiffPanel {...panelProps(overrides)} />);
}

test("does not render anything until the panel has been opened once", async () => {
  const panel = await renderPanel({ visible: false });

  expect(panel.toJSON()).toBeNull();

  await panel.rerender(<GitDiffPanel {...panelProps({ visible: true })} />);

  expect(panel.getAllByText("Git差分").length).toBeGreaterThan(0);

  await panel.rerender(<GitDiffPanel {...panelProps({ visible: false })} />);

  expect(panel.getAllByText("Git差分").length).toBeGreaterThan(0);
});

test("shows the changed file tree collapsed by default and expands on tap", async () => {
  const panel = await renderPanel({
    visible: true,
    gitChangedFilesUnstaged: ["src/a/b.ts"],
  });

  expect(panel.getByText("src")).toBeTruthy();
  expect(panel.queryByText("a")).toBeNull();
  expect(panel.queryByText("b.ts")).toBeNull();

  await fireEvent.press(panel.getByLabelText("srcフォルダーを開閉"));

  expect(panel.getByText("a")).toBeTruthy();
  expect(panel.queryByText("b.ts")).toBeNull();

  await fireEvent.press(panel.getByLabelText("aフォルダーを開閉"));

  expect(panel.getByText("b.ts")).toBeTruthy();
});
