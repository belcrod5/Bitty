import React from "react";
import { render } from "@testing-library/react-native";
import { SkiaBoardActivityStatus } from "./SkiaBoardActivityStatus";
import { VISUAL_THEMES } from "../theme/visualThemes";

const badge = (key: string, label: string, status = "running") => ({
  key, orchestrator: { id: key, name: key, icon: "" }, status, label,
});
const status = (badges: ReturnType<typeof badge>[], theme = VISUAL_THEMES.standard) => (
  <SkiaBoardActivityStatus badges={badges} theme={theme} />
);

test.each([VISUAL_THEMES.standard, VISUAL_THEMES.cyberpunk])(
  "updates activity icons and status, then removes them when no activity remains (%s)",
  async (theme) => {
    const screen = await render(status([], theme));
    expect(screen.queryByTestId("skia-board-activity-indicator")).toBeNull();
    await screen.rerender(status([badge("one", "取得中")], theme));
    expect(screen.getByTestId("skia-board-activity-actor-one")).toBeTruthy();
    expect(screen.getByTestId("skia-board-activity-indicator").props.pointerEvents).toBe("none");
    expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
      .toBe("取得中 · 実行中");
    await screen.rerender(status([badge("two", "会話中")], theme));
    expect(screen.queryByTestId("skia-board-activity-actor-one")).toBeNull();
    expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
    await screen.rerender(status([], theme));
    expect(screen.queryByTestId("skia-board-activity-indicator")).toBeNull();
  },
);

test("deduplicates actors, limits visible icons, and prioritizes running activity", async () => {
  const screen = await render(status([
    badge("one", "取得中", "completed"),
    badge("one", "書き込み中", "completed"),
    badge("two", "ツール実行中"),
    badge("three", "会話中"),
  ]));
  expect(screen.getAllByTestId("skia-board-activity-actor-one")).toHaveLength(1);
  expect(screen.getByTestId("skia-board-activity-actor-two")).toBeTruthy();
  expect(screen.queryByTestId("skia-board-activity-actor-three")).toBeNull();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
    .toBe("ツール実行中 · 実行中");
});

test.each([
  ["completed", "完了"], ["failed", "失敗"], ["interrupted", "中断"], ["unknown", "状態不明"],
])("retains the final %s status", async (state, text) => {
  const screen = await render(status([badge("one", "処理", state)]));
  expect(screen.getByTestId("skia-board-activity-status").props.children.join(""))
    .toBe(`処理 · ${text}`);
});
