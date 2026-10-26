jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
const item = (extra: Partial<LearningKnowledge> = {}): LearningKnowledge => ({ id: "knowledge-1", version: 3, status: "candidate", kind: "preference", content: "報告を短くする", conditions: "作業完了の報告", reason: "簡潔さを希望", scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 1 }], ...extra });
const props = { knowledge: [] as LearningKnowledge[], chatName: "メイン", selecting: false, selected: false, busy: false, onSelect: jest.fn() };
test.each(["candidate", "active"])("%s switch changes eligibility with exact version, without running an answer", async (status) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  const control = screen.getByRole("switch"); expect(control.props.value).toBe(status === "active"); expect(manage).not.toHaveBeenCalled();
  await fireEvent(control, "valueChange", status !== "active"); expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: status === "active" ? "retire" : "adopt" }); await screen.unmount();
});
test.each([[{ action: "retire" }, "停止案を適用"], [{ replaces: ["previous"] }, "この内容に更新"]] as [Partial<LearningKnowledge>, string][])("proposal %j has explicit review action instead of a misleading switch", async (extra, label) => {
  const original = item({ id: "previous", status: "active" });
  const value = item({ ...extra, replacementVersions: [{ id: original.id, version: original.version }] }); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} knowledge={[original, value]} manage={manage} />);
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

test("update proposal compares its exact current source with the new content, then adopts only the proposal", async () => {
  const original = item({ id: "original", status: "active", content: "報告を短くする" });
  const update = item({ id: "update", content: "報告は結論から短く伝える", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={[original, update]} manage={manage} />);
  expect(screen.getByText("更新案")).toBeTruthy(); expect(screen.getByText("現在使用中")).toBeTruthy();
  expect(screen.getByText(original.content)).toBeTruthy(); expect(screen.getByText("更新後")).toBeTruthy(); expect(screen.getByText(update.content)).toBeTruthy();
  expect(screen.getByText("適用すると現在の方針と入れ替わります。")).toBeTruthy(); expect(screen.queryByRole("switch")).toBeNull();
  expect(manage).not.toHaveBeenCalled(); await fireEvent.press(screen.getByLabelText(`この内容に更新: ${update.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: update.id, version: update.version }], action: "adopt" });
  await screen.unmount();
});

test("merged update shows each current source rather than inventing a sequential version", async () => {
  const originals = [item({ id: "first", status: "active", version: 8, content: "結論を先に" }), item({ id: "second", status: "active", version: 12, content: "報告は短く" })];
  const update = item({ content: "結論から短く報告", replaces: originals.map((value) => value.id), replacementVersions: originals.map(({ id, version }) => ({ id, version })) });
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={[...originals, update]} manage={jest.fn(async () => null)} />);
  expect(screen.getAllByText("現在使用中")).toHaveLength(2); originals.forEach((value) => expect(screen.getByText(value.content)).toBeTruthy());
  expect(screen.getByText("まとめて更新後")).toBeTruthy(); expect(screen.queryByText("第4版")).toBeNull(); await screen.unmount();
});

test.each(["missing", "changed", "retired", "unversioned"])("%s update source is never presented as an unchanged current policy", async (state) => {
  const original = item({ id: "original", status: state === "retired" ? "retired" : "active", version: 4 });
  const update = item({ content: "新版", replaces: [original.id], replacementVersions: state === "unversioned" ? undefined : [{ id: original.id, version: state === "changed" ? 3 : 4 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={state === "missing" ? [update] : [original, update]} manage={manage} />);
  expect(screen.queryByText("現在使用中")).toBeNull(); expect(screen.getByText(state === "missing" ? "更新元・確認できません" : "更新元・変更あり")).toBeTruthy();
  expect(screen.getByText("更新元が変わっています。更新案の見直しが必要です。")).toBeTruthy();
  const control = screen.getByLabelText(`この内容に更新: ${update.content}`); expect(control).toBeDisabled(); await fireEvent.press(control);
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("current policy indicates only matching pending updates, not stale, rejected or stopping proposals", async () => {
  const original = item({ id: "original", status: "active" });
  const update = item({ id: "update", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={jest.fn(async () => null)} />);
  expect(screen.getByText("更新案あり")).toBeTruthy(); expect(screen.getByRole("switch")).toBeTruthy();
  for (const extra of [{ status: "rejected" }, { action: "retire" as const }, { replacementVersions: [{ id: original.id, version: 2 }] }]) {
    await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, { ...update, ...extra }]} manage={jest.fn(async () => null)} />);
    expect(screen.queryByText("更新案あり")).toBeNull();
  }
  await screen.unmount();
});

test("stopping and already adopted replacement proposals do not appear as pending updates", async () => {
  const original = item({ id: "original", status: "active" });
  const proposal = item({ replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }], action: "retire" });
  const screen = await render(<LearningKnowledgeCard {...props} item={proposal} knowledge={[original, proposal]} manage={jest.fn(async () => null)} />);
  expect(screen.queryByText("更新案")).toBeNull(); expect(screen.getByText("既存の方針を停止する案")).toBeTruthy(); expect(screen.getByLabelText(`停止案を適用: ${proposal.content}`)).toBeTruthy();
  await screen.rerender(<LearningKnowledgeCard {...props} item={{ ...proposal, action: "create", status: "active" }} knowledge={[]} manage={jest.fn(async () => null)} />);
  expect(screen.queryByText("更新後")).toBeNull(); expect(screen.getByRole("switch").props.value).toBe(true); await screen.unmount();
});


test("opening details reveals the complete original text for update comparison", async () => {
  const original = item({ id: "original", status: "active", content: "長い元の方針を省略せず比較できる" });
  const update = item({ content: "新しい方針", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={[original, update]} manage={jest.fn(async () => null)} />);
  expect(screen.getByText(original.content).props.numberOfLines).toBe(2);
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${update.content}`)); expect(screen.getByText(original.content).props.numberOfLines).toBeUndefined();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${update.content}`)); expect(screen.getByText(original.content).props.numberOfLines).toBe(2); await screen.unmount();
});
