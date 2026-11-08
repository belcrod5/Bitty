jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../clipboard", () => ({ setStringAsync: jest.fn() }));
import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { canApplyLearningProposal, LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
import { humanLearningDate } from "./learningDashboardData";
import { setStringAsync } from "../clipboard";
beforeEach(() => { jest.mocked(setStringAsync).mockReset().mockResolvedValue(true); });
const item = (extra: Partial<LearningKnowledge> = {}): LearningKnowledge => ({ id: "knowledge-1", version: 3, status: "candidate", kind: "preference", content: "報告を短くする", conditions: "作業完了の報告", reason: "簡潔さを希望", scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 1 }], ...extra });
const props = { knowledge: [] as LearningKnowledge[], chatName: "メイン", selecting: false, selected: false, busy: false, onSelect: jest.fn() };
test("adopted version history remains read-only and available on a manually stopped current learning", async () => {
  const current = item({ id: "current", version: 3, status: "retired", content: "現在の報告手順" });
  const previous = item({ id: "previous", version: 5, status: "retired", content: "以前の報告手順", skill: { steps: "以前の確認手順" } });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={current} previousVersions={[previous]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`学習の更新履歴を見る: ${current.content}`));
  expect(screen.getByText(previous.content)).toBeTruthy(); expect(screen.getByText("v5")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`以前の学習IDをコピー: ${previous.id}`));
  expect(setStringAsync).toHaveBeenCalledWith(previous.id);
  await fireEvent.press(screen.getByLabelText("手順の詳細"));
  expect(screen.getByText(/手順: 以前の確認手順/)).toBeTruthy();
  expect(screen.queryByText("この内容に戻す")).toBeNull(); expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("学習の更新履歴を閉じる"));
  expect(screen.queryByText(previous.content)).toBeNull();
  expect(screen.getByRole("switch").props.value).toBe(false); await screen.unmount();
});

test.each(["candidate", "active"])("%s switch changes eligibility with exact version, without running an answer", async (status) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  const control = screen.getByRole("switch"); expect(control.props.value).toBe(status === "active"); expect(manage).not.toHaveBeenCalled();
  await fireEvent(control, "valueChange", status !== "active"); expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: status === "active" ? "retire" : "adopt" }); await screen.unmount();
});
test.each([[{ action: "retire", replaces: ["previous"] }, "停止案を適用"], [{ replaces: ["previous"] }, "更新内容を見る"]] as [Partial<LearningKnowledge>, string][])("proposal %j has explicit review action instead of a misleading switch", async (extra, label) => {
  const original = item({ id: "previous", status: "active" });
  const value = item({ ...extra, replacementVersions: [{ id: original.id, version: original.version }] }); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} knowledge={[original, value]} manage={manage} />);
  expect(screen.queryByRole("switch")).toBeNull(); await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`)); if (value.action !== "retire") { expect(manage).not.toHaveBeenCalled(); await fireEvent.press(screen.getByLabelText(`この案に更新: ${value.content}`)); } expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "adopt" }, ...(value.action !== "retire" ? [false] : [])); await screen.unmount();
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
test.each([["candidate", "学習を削除", "forget", undefined], ["active", "学習を削除", "forget", undefined]])("%s management %s needs confirmation", async (status, label, op, action) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />); await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`)); await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`));
  expect(manage).not.toHaveBeenCalled(); await act(async () => { alert.mock.calls[0][2]?.find((entry) => entry.style !== "cancel")?.onPress?.(); }); expect(manage).toHaveBeenCalledWith(op, { items: [{ id: value.id, version: 3 }], ...(action ? { action } : {}) }); alert.mockRestore(); await screen.unmount();
});
test("published skill action remains separate, while adopted stopping proposal cannot restore itself", async () => {
  const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={item({ status: "active", skill: { purpose: "報告" } })} manage={manage} />);
  await fireEvent.press(screen.getByLabelText("詳細・管理: 報告を短くする")); await fireEvent.press(screen.getByLabelText("専用スキルとして保存: 報告を短くする")); expect(manage).toHaveBeenLastCalledWith("decide", { items: [{ id: "knowledge-1", version: 3 }], action: "publish" });
  expect(screen.queryByLabelText("全チャットで使う: 報告を短くする")).toBeNull();
  await screen.rerender(<LearningKnowledgeCard {...props} item={item({ status: "retired", action: "retire", replaces: ["original"] })} manage={manage} />); expect(screen.queryByRole("switch")).toBeNull(); expect(screen.getByText("再開する場合は元の方針から戻せます。")).toBeTruthy(); await screen.unmount();
});

test("review shows one short comparison with apply and decline; unabridged metadata stays in details", async () => {
  const original = item({ id: "original", status: "active", content: "元の方針", skill: { purpose: "目的の説明", steps: "元の手順" } });
  const update = item({ id: "update", content: "結論から報告", createdAt: "2026-11-03T12:00:00Z", skill: { purpose: "目的の説明", steps: "新しい手順" }, replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={manage} />);
  expect(screen.queryByText(original.conditions)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByText(original.content).props.numberOfLines).toBe(3);
  expect(screen.getByText(update.content).props.numberOfLines).toBe(3);
  expect(screen.getByText(humanLearningDate(update.createdAt!))).toBeTruthy();
  expect(screen.queryByText("使う範囲：メイン限定")).toBeNull();
  expect(screen.queryByText(/元の手順/)).toBeNull(); expect(screen.queryByText(/目的の説明/)).toBeNull();
  expect(screen.queryByText(/簡潔さを希望/)).toBeNull(); expect(screen.queryByText(/第3版/)).toBeNull();
  expect(screen.getByLabelText(`この案に更新: ${update.content}`)).toBeEnabled();
  expect(screen.getByLabelText(`この案を見送る: ${update.content}`)).toBeEnabled();
  await fireEvent.press(screen.getByLabelText("詳細"));
  expect(screen.getByText("使う範囲：メイン限定")).toBeTruthy(); expect(screen.getByText("目的の説明")).toBeTruthy();
  expect(screen.getByText("元の手順\n↓\n新しい手順")).toBeTruthy();
  expect(screen.getByText("理由：簡潔さを希望")).toBeTruthy(); expect(screen.getByText(original.conditions)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${update.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: update.id, version: update.version }], action: "adopt" }, false);
  expect(screen.queryByTestId("learning-update-modal")).toBeNull(); await screen.unmount();
});

test("normal review opens latest applicable proposal and hides a newer stale one in history", async () => {
  const original = item({ id: "original", status: "active", content: "現在の内容" });
  const older = item({ id: "older", content: "選べる古い案", createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-04T00:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const latest = { ...older, id: "latest", content: "選べる最新案", createdAt: "2026-11-03T11:00:00Z" };
  const stale = { ...older, id: "stale", content: "新しいが古い版への案", createdAt: "2026-11-03T12:00:00Z", replacementVersions: [{ id: original.id, version: 2 }] };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, older, stale, latest]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`));
  expect(screen.getByText(latest.content)).toBeTruthy(); expect(screen.queryByText(older.content)).toBeNull(); expect(screen.queryByText(stale.content)).toBeNull();
  await fireEvent.press(screen.getByLabelText("ほかの提案 · 1件"));
  await fireEvent.press(screen.getByLabelText(`提案を見る: ${older.content}`));
  expect(screen.getByText(older.content)).toBeTruthy(); expect(screen.queryByText(stale.content)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${older.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: older.id, version: older.version }], action: "adopt" }, false);
  await screen.unmount();
});

test("metadata-only update previews the actual changed steps, keeping unchanged content and purpose folded", async () => {
  const original = item({ id: "original", status: "active", skill: { purpose: "同じ目的", steps: "古い手順", outputs: "同じ出力" } });
  const update = item({ id: "update", skill: { ...original.skill, steps: "新しい手順" }, replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByText("変更点 · 手順")).toBeTruthy(); expect(screen.getByText("古い手順")).toBeTruthy(); expect(screen.getByText("新しい手順")).toBeTruthy();
  expect(screen.queryByText(original.content)).toBeNull(); expect(screen.queryByText("同じ目的")).toBeNull(); expect(screen.queryByText("同じ出力")).toBeNull();
  await fireEvent.press(screen.getByLabelText("詳細"));
  expect(screen.getByText(original.content)).toBeTruthy(); expect(screen.getByText("同じ目的")).toBeTruthy(); expect(screen.getByText("同じ出力")).toBeTruthy();
  await screen.unmount();
});

test("merged update previews every source; removed conditions and skill values remain explicit in details", async () => {
  const originals = [item({ id: "first", status: "active", version: 8, content: "結論を先に", conditions: "報告時", matchTerms: ["報告"], skill: { steps: "元の手順", approvals: "ユーザー承認" } }), item({ id: "second", status: "active", version: 12, content: "報告は短く", conditions: "メール時" })];
  const update = item({ id: "update", content: "結論から短く報告", conditions: "", targetConstraints: ["対象A"], replaces: originals.map((value) => value.id), replacementVersions: originals.map(({ id, version }) => ({ id, version })) });
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={[...originals, update]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新内容を見る: ${update.content}`));
  originals.forEach((value) => expect(screen.getByText(value.content)).toBeTruthy()); expect(screen.getByText(update.content)).toBeTruthy();
  expect(screen.queryByText(/元の手順/)).toBeNull(); expect(screen.queryByText(/対象A/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("詳細"));
  expect(screen.getByText("報告時\n＋\nメール時\n↓\n条件なし")).toBeTruthy();
  expect(screen.getByText("元の手順\n＋\nなし\n↓\nなし")).toBeTruthy();
  expect(screen.getByText("ユーザー承認\n＋\nなし\n↓\nなし")).toBeTruthy();
  expect(screen.getByText("指定なし\n＋\n指定なし\n↓\n「対象A」")).toBeTruthy();
  expect(screen.getByLabelText(`この案に更新: ${update.content}`)).toBeEnabled(); await screen.unmount();
});

test.each(["missing", "changed", "retired", "unversioned", "scope", "owner"])("%s source is history only, with reject but no apply", async (state) => {
  const original = item({ id: "original", status: state === "retired" ? "retired" : "active", version: 4, scope: { orchestratorId: state === "owner" ? "other" : "main" } });
  const update = item({ id: "update", content: "以前の案", scope: { orchestratorId: "main", ...(state === "scope" ? { shared: true } : {}) }, replaces: [original.id], replacementVersions: state === "unversioned" ? undefined : [{ id: original.id, version: state === "changed" ? 3 : 4 }] });
  const knowledge = state === "missing" ? [update] : [original, update];
  const manage = jest.fn(async () => null);
  expect(canApplyLearningProposal(update, knowledge)).toBe(false);
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={knowledge} manage={manage} />);
  expect(screen.queryByLabelText(`更新内容を見る: ${update.content}`)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`過去の提案を見る: ${update.content}`));
  expect(screen.queryByLabelText(`この案に更新: ${update.content}`)).toBeNull();
  expect(screen.queryByText(/現在の内容には適用できない/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("詳細"));
  expect(screen.getByText("現在の内容には適用できない提案です。")).toBeTruthy();
  if (state === "scope") expect(screen.getByText("使う範囲：全チャット")).toBeTruthy();
  if (state === "owner") expect(screen.getByText(/別のチャット限定/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`この案を見送る: ${update.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: update.id, version: update.version }], action: "reject" }, false);
  await screen.unmount();
});

test("source edit moves the reviewed proposal to history without silently switching or showing a disabled apply", async () => {
  const original = item({ id: "original", status: "active", version: 2, content: "元の方針" });
  const update = item({ id: "update", version: 1, content: "旧版への案", replaces: [original.id], replacementVersions: [{ id: original.id, version: 2 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByLabelText(`この案に更新: ${update.content}`)).toBeEnabled();
  const edited = { ...original, version: 3, content: "今の方針" };
  await screen.rerender(<LearningKnowledgeCard {...props} item={edited} knowledge={[edited, update]} manage={manage} />);
  expect(screen.getByText("この提案は現在の内容に適用できません。")).toBeTruthy(); expect(screen.queryByText(update.content)).toBeNull();
  expect(screen.queryByLabelText(`この案に更新: ${update.content}`)).toBeNull();
  await fireEvent.press(screen.getByLabelText("履歴"));
  await fireEvent.press(screen.getByLabelText(`過去の提案を見る: ${update.content}`));
  expect(screen.getByText(update.content)).toBeTruthy(); expect(screen.queryByLabelText(`この案に更新: ${update.content}`)).toBeNull();
  expect(manage).not.toHaveBeenCalled(); await fireEvent.press(screen.getByLabelText("学習の更新を閉じる"));
  expect(screen.queryByLabelText(`更新案1件を見る: ${edited.content}`)).toBeNull();
  expect(screen.getByLabelText(`提案の履歴を見る: ${edited.content}`)).toBeTruthy(); await screen.unmount();
});

test("stale-only source card has no proposal CTA and can open retained history without changing data", async () => {
  const original = item({ id: "original", status: "active", version: 3, content: "今の方針" });
  const stale = item({ id: "stale", content: "昔の提案", replaces: [original.id], replacementVersions: [{ id: original.id, version: 2 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, stale]} manage={manage} />);
  expect(screen.queryByText("最新の提案を見る")).toBeNull(); expect(screen.queryByText(/新しい提案はありません/)).toBeNull(); expect(screen.queryByText(stale.content)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`提案の履歴を見る: ${original.content}`));
  expect(screen.getByText(stale.content)).toBeTruthy(); expect(screen.queryByLabelText(`この案に更新: ${stale.content}`)).toBeNull();
  expect(screen.getByLabelText(`この案を見送る: ${stale.content}`)).toBeEnabled(); expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("stopping proposals retain direct current-version adoption but stale stops are history only", async () => {
  const original = item({ id: "original", status: "active", version: 3 });
  const proposal = item({ id: "stop", action: "retire", replaces: [original.id], replacementVersions: [{ id: original.id, version: 3 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={proposal} knowledge={[original, proposal]} manage={manage} />);
  expect(canApplyLearningProposal(proposal, [original, proposal])).toBe(true);
  await fireEvent.press(screen.getByLabelText(`停止案を適用: ${proposal.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: proposal.id, version: proposal.version }], action: "adopt" });
  manage.mockClear(); const edited = { ...original, version: 4 };
  await screen.rerender(<LearningKnowledgeCard {...props} item={proposal} knowledge={[edited, proposal]} manage={manage} />);
  expect(screen.queryByLabelText(`停止案を適用: ${proposal.content}`)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`過去の提案を見る: ${proposal.content}`));
  expect(screen.queryByLabelText(`この案に更新: ${proposal.content}`)).toBeNull(); expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("active card does not group current stop, rejected, foreign or partially missing proposals as updates", async () => {
  const original = item({ id: "original", status: "active" });
  const update = item({ id: "update", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={jest.fn(async () => null)} />);
  expect(screen.getByLabelText(`更新案1件を見る: ${original.content}`)).toBeTruthy();
  for (const extra of [{ status: "rejected" }, { action: "retire" as const }, { scope: { orchestratorId: "another" } }, { replaces: [original.id, "missing"] }]) {
    await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, { ...update, ...extra }]} manage={jest.fn(async () => null)} />);
    expect(screen.queryByLabelText(`更新案1件を見る: ${original.content}`)).toBeNull();
  }
  await screen.unmount();
});

test("failed update stays open with the error, closing has no side effects", async () => {
  const original = item({ id: "original", status: "active" });
  const update = item({ id: "update", content: "新版", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const manage = jest.fn(async () => "変更できません");
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`)); await fireEvent.press(screen.getByLabelText(`この案に更新: ${update.content}`));
  expect(screen.getByRole("alert").props.children).toBe("変更できません");
  await fireEvent.press(screen.getByLabelText("学習の更新を閉じる"));
  expect(screen.queryByTestId("learning-update-modal")).toBeNull(); expect(manage).toHaveBeenCalledTimes(1); await screen.unmount();
});

test("changed proposal identity cannot silently select or adopt a different proposal", async () => {
  const original = item({ id: "original", status: "active" });
  const first = item({ id: "first", content: "案A", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const second = { ...first, id: "second", content: "案B" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first, second]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`));
  await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, { ...first, version: 4 }, second]} manage={manage} />);
  expect(screen.getByText("この提案は更新されました。閉じて確認してください。")).toBeTruthy();
  expect(screen.queryByLabelText(`この案に更新: ${second.content}`)).toBeNull(); expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("a newly arriving proposal does not silently replace the reviewed proposal", async () => {
  const original = item({ id: "original", status: "active" });
  const first = item({ id: "first", content: "確認中の案", createdAt: "2026-11-03T10:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const latest = { ...first, id: "latest", content: "あとから届いた案", createdAt: "2026-11-03T11:00:00Z" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first, latest]} manage={manage} />);
  expect(screen.getByText(first.content)).toBeTruthy(); expect(screen.queryByText(latest.content)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${first.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: first.id, version: first.version }], action: "adopt" }, false); await screen.unmount();
});

test("unknown creation dates stay honest and do not outrank a dated actionable proposal", async () => {
  const original = item({ id: "original", status: "active" });
  const unknown = item({ id: "unknown", content: "日時不明案", createdAt: "invalid", updatedAt: "2026-11-04T00:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const dated = { ...unknown, id: "dated", content: "日時既知案", createdAt: "2026-11-03T10:00:00Z" };
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, unknown, dated]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`)); expect(screen.getByText(dated.content)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("ほかの提案 · 1件")); await fireEvent.press(screen.getByLabelText(`提案を見る: ${unknown.content}`));
  expect(screen.getByText("日時不明")).toBeTruthy(); await screen.unmount();
});

test("related proposal, adoption and edit history remains folded and chronological", async () => {
  const original = item({ id: "original", status: "active", content: "今の内容" });
  const proposal = item({ id: "proposal", content: "新しい案", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const rejected = { ...proposal, id: "rejected", status: "rejected", content: "過去に見送った案" };
  const changes = [
    { id: "old", at: "2026-11-03T10:00:00Z", action: "adopt", actor: "user", reason: "採用理由", before: null, after: original },
    { id: "new", at: "2026-11-03T11:00:00Z", action: "edit", actor: "user", reason: "修正理由", before: original, after: original },
    { id: "rejected", at: "2026-11-03T12:00:00Z", action: "reject", actor: "user", reason: "見送り理由", before: rejected, after: rejected },
    { id: "other", at: "2026-11-03T13:00:00Z", action: "created", actor: "ai", reason: "別の学習", before: null, after: item({ id: "other", content: "無関係の内容" }) },
  ];
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, proposal]} changes={changes} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`)); expect(screen.queryByText("過去に見送った案")).toBeNull();
  await fireEvent.press(screen.getByLabelText("履歴")); await fireEvent.press(screen.getByLabelText("学習の履歴 · 3件"));
  expect(screen.getByText("過去に見送った案")).toBeTruthy(); expect(screen.queryByText("無関係の内容")).toBeNull();
  const dates = screen.getAllByText(/ · あなた$/).map((entry) => entry.props.children.join(""));
  expect(dates).toEqual([changes[2], changes[1], changes[0]].map((entry) => `${humanLearningDate(entry.at)} · あなた`));
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test.each(["active", "candidate"])("%s details copy the exact own record ID without changing learning", async (status) => {
  const value = item({ id: "11111111-1111-4111-8111-111111111111", status });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  expect(screen.queryByLabelText(/IDをコピー:/)).toBeNull(); expect(setStringAsync).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  await fireEvent.press(screen.getByLabelText(`${status === "candidate" ? "提案ID" : "学習ID"}をコピー: ${value.id}`));
  expect(setStringAsync).toHaveBeenCalledWith(value.id);
  await waitFor(() => expect(screen.getByText("コピー済み")).toBeTruthy());
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("merged comparison details copy each source ID and proposal ID separately", async () => {
  const originals = [
    item({ id: "11111111-1111-4111-8111-111111111111", status: "active", content: "方針A", version: 3 }),
    item({ id: "22222222-2222-4222-8222-222222222222", status: "active", content: "方針B", version: 4 }),
  ];
  const proposal = item({ id: "33333333-3333-4333-8333-333333333333", content: "統合案", version: 1,
    replaces: originals.map((value) => value.id), replacementVersions: originals.map(({ id, version }) => ({ id, version })) });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={originals[0]} knowledge={[...originals, proposal]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${originals[0].content}`));
  expect(screen.queryByLabelText(/IDをコピー:/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("詳細"));
  for (const source of originals) {
    expect(screen.getAllByText(source.content).some((entry) => entry.props.numberOfLines === 1)).toBe(true);
    await fireEvent.press(screen.getByLabelText(`使用中の学習IDをコピー: ${source.id}`));
  }
  await fireEvent.press(screen.getByLabelText(`提案IDをコピー: ${proposal.id}`));
  expect(jest.mocked(setStringAsync).mock.calls.map(([id]) => id)).toEqual([...originals.map((source) => source.id), proposal.id]);
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test.each(["changed", "missing"])("%s source keeps its known ID copyable without inventing a current version", async (state) => {
  const source = item({ id: "11111111-1111-4111-8111-111111111111", status: "active", version: 3 });
  const proposal = item({ id: "44444444-4444-4444-8444-444444444444", content: "旧版への案", version: 1,
    replaces: [source.id], replacementVersions: [{ id: source.id, version: 2 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={proposal} knowledge={state === "missing" ? [proposal] : [source, proposal]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`過去の提案を見る: ${proposal.content}`));
  await fireEvent.press(screen.getByLabelText("詳細"));
  expect(screen.getByText("v1")).toBeTruthy(); expect(screen.getByText("v2")).toBeTruthy();
  if (state === "changed") expect(screen.getByText("v3")).toBeTruthy();
  else expect(screen.queryByText("v3")).toBeNull();
  expect(screen.queryByText("v0")).toBeNull();
  await fireEvent.press(screen.getByLabelText(`${state === "missing" ? "対象の学習ID" : "使用中の学習ID"}をコピー: ${source.id}`));
  expect(setStringAsync).toHaveBeenCalledWith(source.id);
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test.each(["false", "rejected"])("copy %s reports failure and a successful retry clears it without learning mutations", async (failure) => {
  const copy = jest.mocked(setStringAsync);
  if (failure === "false") copy.mockResolvedValueOnce(false);
  else copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
  const value = item({ status: "active" }); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`詳細・管理: ${value.content}`));
  const button = screen.getByLabelText(`学習IDをコピー: ${value.id}`);
  await fireEvent.press(button);
  await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("コピーできませんでした"));
  expect(screen.queryByText("コピー済み")).toBeNull();
  await fireEvent.press(button);
  await waitFor(() => expect(screen.getByText("コピー済み")).toBeTruthy());
  expect(screen.queryByRole("alert")).toBeNull(); expect(copy).toHaveBeenNthCalledWith(2, value.id);
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});
