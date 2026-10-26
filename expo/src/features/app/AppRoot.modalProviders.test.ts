import { readFileSync } from "node:fs";
import ts from "typescript";

test("the shared modal host retains global providers and covers the drawer and overlay siblings", () => {
  const source = ts.createSourceFile("AppRoot.tsx", readFileSync(`${__dirname}/AppRoot.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hosts: ts.JsxElement[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "AppModalHost") hosts.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(hosts).toHaveLength(1);
  const host = hosts[0];
  const ancestors: string[] = [];
  for (let parent = host.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) ancestors.push(parent.openingElement.tagName.getText(source));
  }
  expect(ancestors).toEqual(expect.arrayContaining([
    "GestureHandlerRootView", "RunnerWebSocketProvider", "AppProviders", "KeyboardProvider",
  ]));
  const descendants: string[] = [];
  function collect(node: ts.Node) {
    if (ts.isJsxElement(node)) descendants.push(node.openingElement.tagName.getText(source));
    if (ts.isJsxSelfClosingElement(node)) descendants.push(node.tagName.getText(source));
    ts.forEachChild(node, collect);
  }
  collect(host);
  expect(descendants).toEqual(expect.arrayContaining([
    "AppDrawerLayout", "DrawerSessionPopupHost", "WidgetSnapshotPublisher", "PushNotificationRegistrar",
  ]));
});
