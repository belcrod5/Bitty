import { useCallback } from "react";
import { requireOptionalNativeModule } from "expo-modules-core";
import { getCloudflareAccessHeadersForUrl } from "../app/utils/cloudflareAccessFetch";
import { streamSttUrl } from "./streamingSttClient";
import type { StreamingSttSession, StreamingSttTransportCallbacks } from "./streamingSttTransport";

type Subscription = { remove(): void };
type NativeStreamingStt = {
  start(url: string, headers: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  addListener(name: string, listener: (event: any) => void): Subscription;
};

export function useStreamingSttTransport() {
  const connect = useCallback((runnerUrl: string, runnerToken: string, callbacks: StreamingSttTransportCallbacks): StreamingSttSession => {
    const token = runnerToken.trim();
    if (!token) throw new Error("runner_token_required");
    const native = requireOptionalNativeModule<NativeStreamingStt>("BittyStreamingStt");
    if (!native) throw new Error("native_stt_unavailable");
    const url = streamSttUrl(runnerUrl);
    const headers = {
      ...getCloudflareAccessHeadersForUrl(url),
      Authorization: `Bearer ${token}`,
    };
    let active = true;
    const subscriptions = [
      native.addListener("BittyStreamingSttMessage", ({ data }: { data: string }) => {
        if (active) callbacks.onMessage(data);
      }),
      native.addListener("BittyStreamingSttSample", ({ rms }: { rms: number }) => {
        if (active && typeof rms === "number" && Number.isFinite(rms)) callbacks.onSample(rms);
      }),
      native.addListener("BittyStreamingSttError", ({ message }: { message: string }) => {
        if (active) callbacks.onError(message);
      }),
      native.addListener("BittyStreamingSttClose", () => {
        if (active) callbacks.onClose();
      }),
    ];
    const abort = async () => {
      if (!active) return;
      active = false;
      subscriptions.forEach((subscription) => subscription.remove());
      await native.abort();
    };
    try {
      void native.start(url, headers).catch((error: unknown) => {
        if (active) callbacks.onError(error instanceof Error ? error.message : "native_stt_start_failed");
      });
    } catch (error) {
      void abort();
      throw error;
    }
    return {
      stop: () => active ? native.stop() : Promise.resolve(),
      abort,
    };
  }, []);

  return { supported: true, connect };
}
