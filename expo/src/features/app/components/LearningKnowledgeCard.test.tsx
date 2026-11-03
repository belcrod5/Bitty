jest.mock("../keyboardController", () => ({ KeyboardAwareScrollView: require("react-native").ScrollView, KeyboardAvoidingView: require("react-native").KeyboardAvoidingView }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { LearningKnowledgeCard, type LearningKnowledge } from "./LearningKnowledgeCard";
import { humanLearningDate } from "./learningDashboardData";
const item = (extra: Partial<LearningKnowledge> = {}): LearningKnowledge => ({ id: "knowledge-1", version: 3, status: "candidate", kind: "preference", content: "報告を短くする", conditions: "作業完了の報告", reason: "簡潔さを希望", scope: { orchestratorId: "main" }, evidence: [{ pairSeq: 1 }], ...extra });
const props = { knowledge: [] as LearningKnowledge[], chatName: "メイン", selecting: false, selected: false, busy: false, onSelect: jest.fn() };
test.each(["candidate", "active"])("%s switch changes eligibility with exact version, without running an answer", async (status) => {
  const value = item({ status }); const manage = jest.fn(async () => null); const screen = await render(<LearningKnowledgeCard {...props} item={value} manage={manage} />);
  const control = screen.getByRole("switch"); expect(control.props.value).toBe(status === "active"); expect(manage).not.toHaveBeenCalled();
  await fireEvent(control, "valueChange", status !== "active"); expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: status === "active" ? "retire" : "adopt" }); await screen.unmount();
});
test.each([[{ action: "retire" }, "停止案を適用"], [{ replaces: ["previous"] }, "更新内容を見る"]] as [Partial<LearningKnowledge>, string][])("proposal %j has explicit review action instead of a misleading switch", async (extra, label) => {
  const original = item({ id: "previous", status: "active" });
  const value = item({ ...extra, replacementVersions: [{ id: original.id, version: original.version }] }); const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={value} knowledge={[original, value]} manage={manage} />);
  expect(screen.queryByRole("switch")).toBeNull(); await fireEvent.press(screen.getByLabelText(`${label}: ${value.content}`)); if (value.replaces) { expect(manage).not.toHaveBeenCalled(); await fireEvent.press(screen.getByLabelText(`この案に更新: ${value.content}`)); } expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: value.id, version: 3 }], action: "adopt" }, ...(value.replaces ? [false] : [])); await screen.unmount();
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

test("current card opens a comparison and applies only the reviewed proposal, never its source", async () => {
  const original = item({ id: "original", status: "active", content: "報告を短くする", scope: { orchestratorId: "main" } });
  const update = item({ id: "update", content: "報告は結論から短く伝える", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={manage} />);
  expect(screen.queryByText(update.content)).toBeNull(); expect(screen.getByRole("switch").props.value).toBe(true);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByText("現在の内容")).toBeTruthy(); expect(screen.getByText(original.content)).toBeTruthy();
  expect(screen.getByText("提案")).toBeTruthy(); expect(screen.getByText(update.content)).toBeTruthy();
  expect(screen.getAllByText("使う範囲：メイン限定")).toHaveLength(2);
  expect(screen.queryByRole("switch")).toBeNull(); expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${update.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: update.id, version: update.version }], action: "adopt" }, false);
  expect(screen.queryByTestId("learning-update-modal")).toBeNull(); await screen.unmount();
});

test("newest proposal opens first by creation time, older alternatives stay folded in chronological order", async () => {
  const original = item({ id: "original", status: "active", updatedAt: "2026-11-03T15:00:00Z" });
  const older = item({ id: "older", content: "古い案", createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T19:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const newest = { ...older, id: "newest", version: 8, content: "最新の案", createdAt: "2026-11-03T12:00:00Z" };
  const middle = { ...older, id: "middle", content: "中間の案", createdAt: "2026-11-03T11:00:00Z" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, older, newest, middle]} manage={manage} />);
  expect(screen.getByText("最新の提案を見る")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`更新案3件を見る: ${original.content}`));
  expect(screen.getByText("最新の提案")).toBeTruthy(); expect(screen.getByText(newest.content)).toBeTruthy();
  expect(screen.queryByText(older.content)).toBeNull(); expect(screen.queryByText(middle.content)).toBeNull();
  expect(screen.queryByText(/使用中：第/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("過去の提案 · 2件（新しい順）"));
  const alternatives = screen.getAllByLabelText(/過去の提案を見る:/);
  expect(alternatives.map((entry) => entry.props.accessibilityLabel)).toEqual([`過去の提案を見る: ${middle.content}`, `過去の提案を見る: ${older.content}`]);
  await fireEvent.press(screen.getByLabelText(`過去の提案を見る: ${older.content}`));
  expect(screen.getByText("過去の提案")).toBeTruthy(); expect(screen.queryByText(newest.content)).toBeNull();
  expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("最新の提案に戻る"));
  expect(screen.getByText(newest.content)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`この案を見送る: ${newest.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: newest.id, version: 8 }], action: "reject" }, false);
  await screen.unmount();
});

test("merged update compares all sources and changed skill and retrieval fields", async () => {
  const originals = [item({ id: "first", status: "active", version: 8, content: "結論を先に", matchTerms: ["報告"], skill: { steps: "元の手順" } }), item({ id: "second", status: "active", version: 12, content: "報告は短く" })];
  const update = item({ content: "結論から短く報告", skill: { steps: "新しい手順" }, targetConstraints: ["対象A"], replaces: originals.map((value) => value.id), replacementVersions: originals.map(({ id, version }) => ({ id, version })) });
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={[...originals, update]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新内容を見る: ${update.content}`));
  expect(screen.getByText("現在の内容 · 2件")).toBeTruthy(); originals.forEach((value) => expect(screen.getByText(value.content)).toBeTruthy());
  expect(screen.getByText("提案")).toBeTruthy(); expect(screen.queryByText("第4版")).toBeNull();
  expect(screen.getByText(/手順: 元の手順/)).toBeTruthy(); expect(screen.getByText(/手順: 新しい手順/)).toBeTruthy();
  expect(screen.getByText("関連する言葉：指定なし")).toBeTruthy(); expect(screen.getByText("確認対象：対象A")).toBeTruthy();
  await screen.unmount();
});

test.each(["missing", "changed", "retired", "unversioned", "scope"])("%s update source can be inspected but never applied", async (state) => {
  const original = item({ id: "original", status: state === "retired" ? "retired" : "active", version: 4 });
  const update = item({ content: "新版", scope: { orchestratorId: "main", ...(state === "scope" ? { shared: true } : {}) }, replaces: [original.id], replacementVersions: state === "unversioned" ? undefined : [{ id: original.id, version: state === "changed" ? 3 : 4 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={update} knowledge={state === "missing" ? [update] : [original, update]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新内容を見る: ${update.content}`));
  expect(screen.getByText(state === "changed" ? "この提案のあとに、使用中の内容が更新されました。現在の内容をもとに提案し直してください。" : "現在の内容に対する提案と確認できないため、適用できません。")).toBeTruthy();
  const control = screen.getByLabelText(`この案に更新: ${update.content}`); expect(control).toBeDisabled(); await fireEvent.press(control);
  expect(manage).not.toHaveBeenCalled(); expect(screen.getByLabelText(`この案を見送る: ${update.content}`)).toBeEnabled(); await screen.unmount();
});

test("editing a source keeps its older proposal attached but prevents applying it", async () => {
  const original = item({ id: "original", status: "active", version: 2, content: "元の方針" });
  const update = item({ id: "update", version: 1, content: "第2版への更新案", replaces: [original.id], replacementVersions: [{ id: original.id, version: 2 }] });
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByLabelText(`この案に更新: ${update.content}`)).toBeEnabled();
  const edited = { ...original, version: 3, content: "会話から修正した方針" };
  await screen.rerender(<LearningKnowledgeCard {...props} item={edited} knowledge={[edited, update]} manage={manage} />);
  expect(screen.getByText(edited.content)).toBeTruthy();
  expect(screen.getByText("現在の内容")).toBeTruthy();
  expect(screen.getByText("以前の内容への提案")).toBeTruthy();
  expect(screen.queryByText(/使用中：第3版/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("版の詳細"));
  expect(screen.getByText("使用中：第3版 · 提案の対象：第2版")).toBeTruthy();
  expect(screen.getByText(update.content)).toBeTruthy();
  expect(screen.getByText("この提案のあとに、使用中の内容が更新されました。現在の内容をもとに提案し直してください。")).toBeTruthy();
  const control = screen.getByLabelText(`この案に更新: ${update.content}`);
  expect(control).toBeDisabled(); await fireEvent.press(control);
  expect(manage).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("学習の更新を閉じる"));
  expect(screen.getByLabelText(`更新案1件を見る: ${edited.content}`)).toBeTruthy();
  await screen.unmount();
});

test("active source ignores rejected, stopping and partially invalid merged updates", async () => {
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
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${update.content}`));
  expect(screen.getByRole("alert").props.children).toBe("変更できません");
  await fireEvent.press(screen.getByLabelText("学習の更新を閉じる"));
  expect(screen.queryByTestId("learning-update-modal")).toBeNull(); expect(manage).toHaveBeenCalledTimes(1); await screen.unmount();
});

test("a changed proposal is not silently replaced with another choice while reviewing", async () => {
  const original = item({ id: "original", status: "active" });
  const first = item({ id: "first", content: "案A", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const second = { ...first, id: "second", content: "案B" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first, second]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`));
  await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, { ...first, version: 4 }, second]} manage={manage} />);
  expect(screen.getByText("この更新案は状態が変わりました。閉じて確認してください。")).toBeTruthy();
  expect(screen.queryByLabelText(`この案に更新: ${second.content}`)).toBeNull(); expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("stopping and already adopted proposals retain their own controls", async () => {
  const original = item({ id: "original", status: "active" });
  const proposal = item({ replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }], action: "retire" });
  const screen = await render(<LearningKnowledgeCard {...props} item={proposal} knowledge={[original, proposal]} manage={jest.fn(async () => null)} />);
  expect(screen.getByText("既存の方針を停止する案")).toBeTruthy(); expect(screen.getByLabelText(`停止案を適用: ${proposal.content}`)).toBeTruthy();
  await screen.rerender(<LearningKnowledgeCard {...props} item={{ ...proposal, action: "create", status: "active" }} knowledge={[]} manage={jest.fn(async () => null)} />);
  expect(screen.queryByLabelText(`更新内容を見る: ${proposal.content}`)).toBeNull(); expect(screen.getByRole("switch").props.value).toBe(true); await screen.unmount();
});

test("removed conditions and skill fields are explicit without repeating unchanged skill details", async () => {
  const original = item({ id: "original", status: "active", skill: { purpose: "同じ目的", steps: "古い手順", approvals: "ユーザー承認" } });
  const update = item({ id: "update", content: "新版", conditions: "", skill: { purpose: "同じ目的", steps: "新しい手順" }, replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, update]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.getByText("適用：条件なし")).toBeTruthy(); expect(screen.queryByText(/同じ目的/)).toBeNull();
  expect(screen.getByText(/必要な承認: なし/)).toBeTruthy(); expect(screen.getByText(/手順: 新しい手順/)).toBeTruthy(); await screen.unmount();
});


test("latest stale proposal stays latest without enabling it over an older applicable proposal", async () => {
  const original = item({ id: "original", status: "active", version: 3, updatedAt: "2026-11-03T15:00:00Z" });
  const older = item({ id: "older", content: "適用できる古い提案", createdAt: "2026-11-03T10:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: 3 }] });
  const latest = { ...older, id: "latest", content: "適用できない最新の提案", createdAt: "2026-11-03T11:00:00Z", replacementVersions: [{ id: original.id, version: 2 }] };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[older, original, latest]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`));
  expect(screen.getByText("最新の提案")).toBeTruthy();
  expect(screen.getByText(`提案：${humanLearningDate(latest.createdAt)}`)).toBeTruthy();
  expect(screen.getByText(`更新：${humanLearningDate(original.updatedAt!)}`)).toBeTruthy();
  expect(screen.getByLabelText(`この案に更新: ${latest.content}`)).toBeDisabled();
  expect(screen.queryByText(older.content)).toBeNull(); expect(manage).not.toHaveBeenCalled();
  await screen.unmount();
});

test("unknown proposal dates are shown honestly and do not outrank a dated proposal", async () => {
  const original = item({ id: "original", status: "active" });
  const unknown = item({ id: "unknown", content: "日時不明の案", createdAt: "invalid", updatedAt: "2026-11-04T00:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const dated = { ...unknown, id: "dated", content: "日時がわかる案", createdAt: "2026-11-03T10:00:00Z" };
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, unknown, dated]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新案2件を見る: ${original.content}`));
  expect(screen.getByText(dated.content)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("過去の提案 · 1件（新しい順）"));
  expect(screen.getByText("提案：日時不明")).toBeTruthy();
  await screen.unmount();
});

test("a newly arriving proposal does not silently replace the one being reviewed", async () => {
  const original = item({ id: "original", status: "active" });
  const first = item({ id: "first", content: "確認中の案", createdAt: "2026-11-03T10:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const latest = { ...first, id: "latest", content: "あとから届いた案", createdAt: "2026-11-03T11:00:00Z" };
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first]} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  await screen.rerender(<LearningKnowledgeCard {...props} item={original} knowledge={[original, first, latest]} manage={manage} />);
  expect(screen.getByText(first.content)).toBeTruthy(); expect(screen.queryByText(latest.content)).toBeNull();
  await fireEvent.press(screen.getByLabelText(`この案に更新: ${first.content}`));
  expect(manage).toHaveBeenCalledWith("decide", { items: [{ id: first.id, version: first.version }], action: "adopt" }, false);
  await screen.unmount();
});

test("related proposal, adoption and edit history reuses existing chronological disclosure", async () => {
  const original = item({ id: "original", status: "active", content: "今の内容" });
  const proposal = item({ id: "proposal", content: "最新案", createdAt: "2026-11-03T12:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const rejected = { ...proposal, id: "rejected", status: "rejected", content: "過去に見送った案" };
  const changes = [
    { id: "old", at: "2026-11-03T10:00:00Z", action: "adopt", actor: "user", reason: "採用理由", before: null, after: original },
    { id: "new", at: "2026-11-03T11:00:00Z", action: "edit", actor: "user", reason: "修正理由", before: original, after: original },
    { id: "rejected", at: "2026-11-03T12:00:00Z", action: "reject", actor: "user", reason: "見送り理由", before: rejected, after: rejected },
    { id: "other", at: "2026-11-03T13:00:00Z", action: "created", actor: "ai", reason: "別の学習", before: null, after: item({ id: "other", content: "無関係の内容" }) },
  ];
  const manage = jest.fn(async () => null);
  const screen = await render(<LearningKnowledgeCard {...props} item={original} knowledge={[original, proposal]} changes={changes} manage={manage} />);
  await fireEvent.press(screen.getByLabelText(`更新案1件を見る: ${original.content}`));
  expect(screen.queryByText("過去に見送った案")).toBeNull();
  await fireEvent.press(screen.getByLabelText("学習の履歴 · 3件"));
  expect(screen.getByText("過去に見送った案")).toBeTruthy();
  expect(screen.queryByText("無関係の内容")).toBeNull();
  const dates = screen.getAllByText(/ · あなた$/).map((entry) => entry.props.children.join(""));
  expect(dates).toEqual([changes[2], changes[1], changes[0]].map((entry) => `${humanLearningDate(entry.at)} · あなた`));
  expect(manage).not.toHaveBeenCalled(); await screen.unmount();
});

test("opening an older standalone proposal never labels it latest and can return to the actual latest", async () => {
  const original = item({ id: "original", status: "active" });
  const older = item({ id: "older", content: "単独で開いた過去案", createdAt: "2026-11-03T10:00:00Z", replaces: [original.id], replacementVersions: [{ id: original.id, version: original.version }] });
  const latest = { ...older, id: "latest", content: "実際の最新案", createdAt: "2026-11-03T11:00:00Z" };
  const screen = await render(<LearningKnowledgeCard {...props} item={older} knowledge={[original, older, latest]} manage={jest.fn(async () => null)} />);
  await fireEvent.press(screen.getByLabelText(`更新内容を見る: ${older.content}`));
  expect(screen.getByText("過去の提案")).toBeTruthy(); expect(screen.queryByText("最新の提案")).toBeNull();
  expect(screen.getByText(older.content)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("最新の提案に戻る"));
  expect(screen.getByText("最新の提案")).toBeTruthy(); expect(screen.getByText(latest.content)).toBeTruthy();
  await screen.unmount();
});
