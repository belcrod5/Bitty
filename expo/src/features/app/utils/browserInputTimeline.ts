import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";

export type BrowserInputTimelineCard = { id: string; at: string; role?: never; browserInput: BrowserSecretInputRequest };

// Presentation only. Keep original conversation objects intact for model/search/TTS consumers.
export function browserInputTimeline<T extends { at?: string }>(messages: T[], requests: readonly BrowserSecretInputRequest[]): Array<T | BrowserInputTimelineCard> {
  if (!requests.length) return messages;
  const items: Array<T | BrowserInputTimelineCard> = [...messages];
  for (const request of [...requests].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const card: BrowserInputTimelineCard = { id: `browser-input:${request.requestId}`, at: request.createdAt, browserInput: request };
    const position = items.findIndex((item) => Date.parse(item.at || "") > Date.parse(request.createdAt));
    items.splice(position < 0 ? items.length : position, 0, card);
  }
  return items;
}
