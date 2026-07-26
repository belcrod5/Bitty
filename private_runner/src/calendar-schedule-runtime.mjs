export function createCalendarScheduleRuntime({
  upstreamUrl,
  upstreamToken,
  capabilityUrl,
  capabilityToken,
  fetchImpl,
  createClient,
  executeTurn,
  dynamicTools,
  createRequestHandler,
  createReadRequest,
}) {
  function capabilityMatches(value) {
    const sandbox = value?.sandbox && typeof value.sandbox === "object" ? value.sandbox : value;
    const calendarRead = value?.capability === "calendar-read-v1"
      || (Array.isArray(value?.capabilities) && value.capabilities.includes("calendar-read-v1"));
    return calendarRead
      && sandbox?.hostMounts === false
      && sandbox?.inheritedEnv === false
      && sandbox?.toolNetwork === false;
  }

  function connectionOptions() {
    if (!upstreamUrl) return null;
    return { upstreamUrl, upstreamToken };
  }

  async function preflight() {
    if (!upstreamUrl || !capabilityUrl || !capabilityToken) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetchImpl(capabilityUrl, {
        headers: { authorization: `Bearer ${capabilityToken}` },
        signal: controller.signal,
      });
      return response.ok && capabilityMatches(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function run({ clientName, origin, signal, onTurnStarted, request }) {
    let client = null;
    try {
      const connection = connectionOptions();
      if (!connection) throw new Error("calendar_api_failed");
      client = createClient({ signal, ...connection });
      return await executeTurn({
        client,
        clientName,
        onTurnStarted,
        ...request,
        calendarSchedule: {
          ruleId: request.ruleId,
          ruleRevision: request.ruleRevision,
          deviceId: request.calendarDeviceId,
          dynamicTools: dynamicTools(),
          handleServerRequest: createRequestHandler({ createReadRequest }),
        },
      });
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes("codex_dynamic_tools_incompatible")) throw error;
      throw new Error("calendar_api_failed");
    } finally {
      client?.close(1000, "calendar_turn_done");
    }
  }

  return { capabilityMatches, connectionOptions, preflight, run };
}
