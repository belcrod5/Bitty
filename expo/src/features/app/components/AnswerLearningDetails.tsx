import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketContext";

type Item = { id: string; version: number; name?: string; hash?: string; callId?: string };
type Delivery = { contextRevision: number; selectedDigest: string; items: Item[]; reads: Item[]; inheritedReads: Item[]; readsVerified?: boolean };

export function AnswerLearningDetails({ orchestratorId, operationId, color, paused = false }: {
  orchestratorId: string; operationId: string; color: string; paused?: boolean;
}) {
  const manager = useRunnerWebSocketManager();
  const [open, setOpen] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);
  useEffect(() => {
    if (paused) { requestId.current += 1; setOpen(false); setDelivery(null); setLoading(false); }
    return () => { requestId.current += 1; };
  }, [paused]);
  const show = async () => {
    if (open) { setOpen(false); return; }
    const id = ++requestId.current;
    setOpen(true); setLoading(true); setFailed(false);
    try {
      const response = await manager.request({ channel: "agent", op: "voice.learning.delivery", payload: { orchestratorId, operationId } });
      if (id !== requestId.current) return;
      const value = (response.payload as { delivery?: Delivery | null })?.delivery;
      if (value && (!Array.isArray(value.items) || !Array.isArray(value.reads) || !Array.isArray(value.inheritedReads))) throw new Error("Invalid delivery");
      setDelivery(value || null);
    } catch { if (id === requestId.current) setFailed(true); }
    finally { if (id === requestId.current) setLoading(false); }
  };
  const names = (items: Item[]) => items.map((item) => `${item.name || item.id} v${item.version}${item.hash ? ` (${item.hash.slice(0, 12)})` : ""}`).join("、") || "なし";
  return <View style={{ marginTop: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="回答の学習・参照詳細" disabled={paused} onPress={() => void show()}>
      <Text style={{ color, fontSize: 11 }}>学習・参照詳細 {open ? "▴" : "▾"}</Text>
    </Pressable>
    {open ? loading ? <Text style={{ color, fontSize: 11 }}>読込中…</Text> : failed || !delivery
      ? <Text style={{ color, fontSize: 11 }}>配送・参照記録は未確認です（保持期間外・忘却後を含む）。</Text>
      : <>
        <Text style={{ color, fontSize: 11 }}>モデルに渡した学習: {names(delivery.items)}</Text>
        <Text style={{ color, fontSize: 11 }}>このターンで参照した専用スキル: {names(delivery.reads)}{delivery.readsVerified ? "" : "（記録未確認）"}</Text>
        <Text style={{ color, fontSize: 11 }}>親に残る参照: {names(delivery.inheritedReads)}</Text>
        <Text style={{ color, fontSize: 11 }}>配送版 {delivery.contextRevision} · {delivery.selectedDigest.slice(0, 12)}。配送・読取は回答への影響を証明しません。</Text>
      </> : null}
  </View>;
}
