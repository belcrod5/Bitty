jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
const item = (extra: Partial<LearningKnowledge> = {}): LearningKnowledge => ({ id: "knowledge-1", version: 3,
  status: "candidate", kind: "preference", content: "報告を短くする", conditions: "作業完了の報告", reason: "簡潔さを希望",
  scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 1 }], ...extra });
const props = { chatName: "メイン", selecting: false, selected: false, busy: false, onSelect: jest.fn() };

test.each([
  [{}, "回答に使う"],
  [{ action: "retire" }, "使用停止を採用"],
  [{ replaces: ["previous"] }, "変更を採用"],
  [{ scope: { orchestratorId: "main", shared: true } }, "回答に使う"],
] as [Partial<LearningKnowledge>, string][])("candidate action %j uses accurate label and exact current version", async (extra, label) => {
  const value = item(extra); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  expect(screen.getByText("候補・未使用")).toBeTruthy();
  expect(screen.getByText(value.scope.shared ? "全チャット" : "メイン限定")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull(); expect(screen.queryByText(value.reason)).toBeNull();
  expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "adopt" });
  await screen.unmount();
});

test("selection is separate from adoption and management details are folded", async () => {
  const value = item(); const onSelect = jest.fn(); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} selecting item={value} onSelect={onSelect} manage={manage} />);
  await fireEvent.press(screen.getByRole("checkbox")); expect(onSelect).toHaveBeenCalledTimes(1);
  expect(manage).not.toHaveBeenCalled(); expect(screen.queryByText("回答に使う")).toBeNull();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  expect(screen.getByText(`作成理由：${value.reason}`)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`見送る: ${value.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "reject" });
  await screen.unmount();
});

test.each([
  ["candidate", "学習を削除", "forget", undefined],
  ["active", "全チャットで使う", "decide", "share"],
  ["retired", "この方針に戻す", "decide", "restore"],
])("%s management %s needs explicit confirmation", async (status, label, op, action) => {
  const value = item({ status }); const manage = jest.fn(async () => null);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`));
  expect(manage).not.toHaveBeenCalled();
  await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style !== "cancel")?.onPress?.(); });
  expect(manage).toHaveBeenCalledWith(op, { items: [{ id: value.id, version: 3 }], ...(action ? { action } : {}) });
  alert.mockRestore(); await screen.unmount();
});

test("active skill keeps stop and dedicated save separate from adoption", async () => {
  const value = item({ status: "active", skill: { purpose: "短い報告" } }); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  expect(screen.getByText("採用済み")).toBeTruthy(); expect(screen.queryByText("回答に使う")).toBeNull();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  await fireEvent.press(screen.getByLabelText(`専用スキルとして保存: ${value.content}`));
  expect(manage).toHaveBeenLastCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "publish" });
  await fireEvent.press(screen.getByLabelText(`使用を停止: ${value.content}`));
  expect(manage).toHaveBeenLastCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "retire" });
  await screen.unmount();
});

test("adopted stopping proposal cannot resume itself as a response policy", async () => {
  const value = item({ status: "retired", action: "retire", replaces: ["original-policy"] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  expect(screen.getByText("停止中")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  expect(screen.queryByLabelText(`この方針に戻す: ${value.content}`)).toBeNull();
  expect(screen.getByText("再開する場合は元の方針から戻せます。")).toBeTruthy();
  expect(manage).not.toHaveBeenCalled();
  await screen.unmount();
});
