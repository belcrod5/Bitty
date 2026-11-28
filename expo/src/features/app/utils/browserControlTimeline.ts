import type { BrowserControlRequest } from "../hooks/useBrowserControl";

export type BrowserControlTimelineCard = { id: string; at: string; role?: never; browserInput: BrowserControlRequest };

// Presentation only. Keep original conversation objects intact for model/search/TTS consumers.
export function browserControlTimeline<T extends { at?: string }>(messages: T[], requests: readonly BrowserControlRequest[]): Array<T | BrowserControlTimelineCard> {
  if (!requests.length) return messages;
  const items: Array<T | BrowserControlTimelineCard> = [...messages];
  for (const request of [...requests].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const card: BrowserControlTimelineCard = { id: `browser-control:${request.requestId}`, at: request.createdAt, browserInput: request };
    const position = items.findIndex((item) => Date.parse(item.at || "") > Date.parse(request.createdAt));
    items.splice(position < 0 ? items.length : position, 0, card);
  }
  return items;
}
