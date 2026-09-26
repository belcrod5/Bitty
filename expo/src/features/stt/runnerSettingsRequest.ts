export async function runnerSettingsRequest(
  runnerUrl: string,
  runnerToken: string,
  path: string,
  init: RequestInit = {}
) {
  const token = String(runnerToken || "").trim();
  if (!token) throw new Error("Runner token is required.");
  const endpoint = `${String(runnerUrl || "").trim().replace(/\/$/, "")}${path}`;
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.message || `Runner request failed (${response.status}).`));
  return payload;
}
