import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { GitBranchDropdown, type GitBranchOption } from "./GitBranchDropdown";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const branches: GitBranchOption[] = [
  { name: "main", kind: "local" },
  { name: "feature/local", kind: "local" },
  { name: "origin/main", kind: "remote" },
];

test("groups branches and keeps the current branch selected", async () => {
  const dropdown = await render(
    <GitBranchDropdown currentBranchName="main" branches={branches} />
  );

  expect(dropdown.getByText("main")).toBeTruthy();
  await fireEvent.press(dropdown.getByLabelText("ブランチ一覧を開く"));

  expect(dropdown.getByText("Local")).toBeTruthy();
  expect(dropdown.getByText("Remote")).toBeTruthy();
  await fireEvent.press(dropdown.getByLabelText("Remote origin/main"));

  expect(dropdown.getByText("main")).toBeTruthy();
  expect(dropdown.queryByText("origin/main")).toBeNull();
});

test("shows detached HEAD without adding it as a local branch", async () => {
  const dropdown = await render(
    <GitBranchDropdown currentBranchName="HEAD" branches={branches} />
  );

  expect(dropdown.getByText("detached")).toBeTruthy();
  expect(dropdown.getByText("HEAD")).toBeTruthy();
  await fireEvent.press(dropdown.getByLabelText("ブランチ一覧を開く"));
  expect(dropdown.queryByLabelText("Local HEAD")).toBeNull();
});
