import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { InternalContextMessage } from "./InternalContextMessage";

jest.mock("./MarkdownText", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    MarkdownText: ({ content }: { content: string }) => React.createElement(Text, null, content),
  };
});

test("keeps unclassified Codex context unmounted until the user expands it", async () => {
  const view = await render(
    <InternalContextMessage content="long context body" unclassified textStyle={{}} />
  );

  expect(view.getByText("CODEX CONTEXT · 未分類")).toBeTruthy();
  expect(view.queryByText("long context body")).toBeNull();

  await fireEvent.press(view.getByLabelText("Codex情報を展開"));
  expect(view.getByText("long context body")).toBeTruthy();

  await fireEvent.press(view.getByLabelText("Codex情報を折りたたむ"));
  expect(view.queryByText("long context body")).toBeNull();
});
