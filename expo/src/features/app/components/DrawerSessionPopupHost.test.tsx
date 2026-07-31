import React from "react";
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { DrawerSessionPopupHost } from "./DrawerSessionPopupHost";

type RenderedNode =
  | { type?: unknown; children?: RenderedNode[] | null }
  | string
  | null;

function containsSafeAreaView(node: RenderedNode | RenderedNode[] | null): boolean {
  if (!node) return false;
  if (Array.isArray(node)) return node.some((child) => containsSafeAreaView(child));
  if (typeof node === "string") return false;
  if (String(node.type || "").includes("SafeAreaView")) return true;
  return containsSafeAreaView(node.children ?? null);
}

test("wraps drawer-origin popups in a SafeAreaView", async () => {
  const host = await render(
    <DrawerSessionPopupHost origin="drawer" hostStyle={{}} safeAreaStyle={{}}>
      <Text>popup</Text>
    </DrawerSessionPopupHost>
  );

  expect(host.getByText("popup")).toBeTruthy();
  expect(containsSafeAreaView(host.toJSON() as RenderedNode)).toBe(true);
});

test("renders skia-board-origin popups without a SafeAreaView", async () => {
  // skiaボードは全画面キャンバスへ直接重ねる従来のskiaポップアップの見た目を踏襲する。
  const host = await render(
    <DrawerSessionPopupHost origin="skia_board" hostStyle={{}} safeAreaStyle={{}}>
      <Text>popup</Text>
    </DrawerSessionPopupHost>
  );

  expect(host.getByText("popup")).toBeTruthy();
  expect(containsSafeAreaView(host.toJSON() as RenderedNode)).toBe(false);
});
