jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
const item = (extra: Partial<LearningKnowledge> = {}): LearningKnowledge => ({ id: "knowledge-1", version: 3, status: "candidate", kind: "preference", content: "報告を短くする", conditions: "作業完了の報告", reason: "簡潔さを希望", scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 1 }], ...extra });
const props = { chatName: "メイン", selecting: false, selected: false, busy: false, onSelect: jest.fn() };
test.each(["candidate", "active"])("%s switch changes eligibility with exact version, without running an answer", async (status) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  const control = screen.getByRole("switch"); expect(control.props.value).toBe(status === "active"); expect(manage).not.toHaveBeenCalled();
  await fireEvent(control, "valueChange", status !== "active"); expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: status === "active" ? "retire" : "adopt" }); await screen.unmount();
});
test.each([[{ action: "retire" }, "停止案を適用"], [{ replaces: ["previous"] }, "変更案を適用"]] as [Partial<LearningKnowledge>, string][])("proposal %j has explicit review action instead of a misleading switch", async (extra, label) => {
  const value = item(extra); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  expect(screen.queryByRole("switch")).toBeNull(); await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`)); expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "adopt" }); await screen.unmount();
});
test("restoring stopped knowledge confirms replacement consequences before any mutation", async () => {
  const value = item({ status: "retired" }); const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />); await fireEvent(screen.getByRole("switch"), "valueChange", true); expect(manage).not.toHaveBeenCalled();
  expect(alert.mock.calls[0][1]).toContain("置き換え先"); await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.text === "再開する")?.onPress?.(); });
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "restore" }); alert.mockRestore(); await screen.unmount();
});
test.each(["rejected", "unknown"])("%s never offers a fake unsupported toggle", async (status) => {
  const screen = await render(<LearningKnowledgeCard {...props} item={item({ status })} manage={jest.fn(async () => null)} />); expect(screen.queryByRole("switch")).toBeNull(); await screen.unmount();
});
test("bulk checkbox only selects, hiding use switch; evidence stays inside management", async () => {
  const value = item(); const onSelect = jest.fn(); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} selecting item={value} onSelect={onSelect} manage={manage} />);
  await fireEvent.press(screen.getByRole("checkbox")); expect(onSelect).toHaveBeenCalledTimes(1); expect(manage).not.toHaveBeenCalled(); expect(screen.queryByRole("switch")).toBeNull();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`)); expect(screen.getByText("根拠：1件のやりとり")).toBeTruthy(); await fireEvent.press(screen.getByLabelText(`見送る: ${value.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "reject" }); await screen.unmount();
});
test.each([["candidate", "学習を削除", "forget", undefined], ["active", "全チャットで使う", "decide", "share"]])("%s management %s needs confirmation", async (status, label, op, action) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />); await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`)); await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`));
  expect(manage).not.toHaveBeenCalled(); await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style !== "cancel")?.onPress?.(); }); expect(manage).toHaveBeenCalledWith(op, { items: [{ id: value.id, version: 3 }], ...(action ? { action } : {}) }); alert.mockRestore(); await screen.unmount();
});
test("published skill action remains separate, while adopted stopping proposal cannot restore itself", async () => {
  const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={item({ status: "active", skill: { purpose: "報告" } })} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("詳細・管理: 報告を短くする")); await fireEvent.press(screen.getByLabelText("専用スキルとして保存: 報告を短くする")); expect(manage).toHaveBeenLastCalledWith("decide", { items: [{ id: "knowledge-1", version: 3 }], action: "publish" });
  await screen.rerender(<LearningKnowledgeCard {...props} item={item({ status: "retired", action: "retire", replaces: ["original"] })} manage={manage} />); expect(screen.queryByRole("switch")).toBeNull(); expect(screen.getByText("再開する場合は元の方針から戻せます。")).toBeTruthy(); await screen.unmount();
});
