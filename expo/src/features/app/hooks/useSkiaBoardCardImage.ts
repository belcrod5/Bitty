import { useEffect, useState } from "react";
import { useImage } from "@shopify/react-native-skia";
import { buildRunnerMediaFileUrl } from "../utils/runnerFileContextMenu";

const imageBytesByRequest = new Map<string, Uint8Array>();
const IMAGE_REQUEST_TIMEOUT_MS = 12_000;
type ImageRequest = {
  controller: AbortController;
  promise: Promise<Uint8Array>;
  users: number;
};
const imageRequests = new Map<string, ImageRequest>();

function runnerPathParent(pathRaw: string) {
  const path = pathRaw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex <= 0) return separatorIndex === 0 ? "/" : path;
  return path.slice(0, separatorIndex);
}

function acquireImageBytes(url: string, token: string) {
  const key = `${url}\n${token}`;
  const cached = imageBytesByRequest.get(key);
  if (cached) return { promise: Promise.resolve(cached), release: () => {} };
  const pending = imageRequests.get(key);
  if (pending) {
    pending.users += 1;
    return {
      promise: pending.promise,
      release: () => {
        pending.users -= 1;
        if (pending.users === 0) {
          if (imageRequests.get(key) === pending) imageRequests.delete(key);
          pending.controller.abort();
        }
      },
    };
  }
  const controller = new AbortController();
  const request = {} as ImageRequest;
  request.controller = controller;
  request.users = 1;
  const timeoutHandle = setTimeout(() => {
    if (imageRequests.get(key) === request) imageRequests.delete(key);
    controller.abort();
  }, IMAGE_REQUEST_TIMEOUT_MS);
  request.promise = fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    imageBytesByRequest.set(key, bytes);
    return bytes;
  }).finally(() => {
    clearTimeout(timeoutHandle);
    if (imageRequests.get(key) === request) imageRequests.delete(key);
  });
  imageRequests.set(key, request);
  return {
    promise: request.promise,
    release: () => {
      request.users -= 1;
      if (request.users === 0) {
        if (imageRequests.get(key) === request) imageRequests.delete(key);
        request.controller.abort();
      }
    },
  };
}

export function useSkiaBoardCardImage(
  runnerUrl: string,
  runnerToken: string,
  imagePath?: string
) {
  const path = String(imagePath || "").trim();
  const url = path ? buildRunnerMediaFileUrl({
    runnerUrl,
    rootDir: runnerPathParent(path),
    path,
  }) : "";
  const cacheKey = url && runnerToken ? `${url}\n${runnerToken}` : "";
  const [bytes, setBytes] = useState<Uint8Array | null>(
    cacheKey ? imageBytesByRequest.get(cacheKey) || null : null
  );

  useEffect(() => {
    let active = true;
    setBytes(cacheKey ? imageBytesByRequest.get(cacheKey) || null : null);
    if (!url || !runnerToken || imageBytesByRequest.has(cacheKey)) {
      return () => { active = false; };
    }
    const request = acquireImageBytes(url, runnerToken);
    void request.promise
      .then((nextBytes) => {
        if (active) setBytes(nextBytes);
      })
      .catch(() => {
        if (active) setBytes(null);
      });
    return () => {
      active = false;
      request.release();
    };
  }, [cacheKey, runnerToken, url]);

  return useImage(bytes);
}
