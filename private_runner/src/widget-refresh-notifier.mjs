// Background pushes are hints, not a live stream. Keep the latest change pending within Apple's budget.
const MIN_INTERVAL_MS = 20 * 60 * 1000;
export function createWidgetRefreshNotifier({ enabled, apnsClient, deviceStore, now = Date.now, schedule = setTimeout }) {
  let lastSent = -Infinity;
  let timer = null;
  let dirty = false;
  let inFlight = false;
  async function flush() {
    timer = null;
    if (!dirty || inFlight) return;
    dirty = false;
    inFlight = true;
    lastSent = now();
    try {
      const devices = await deviceStore.listDevices();
      await Promise.allSettled(devices.map(async (device) => {
        const result = await apnsClient.sendToDevice(device.apnsToken,
          { aps: { "content-available": 1 }, bittyWidgetRefresh: 1 },
          { env: device.env, pushType: "background", priority: 5, collapseId: "bitty-widget-refresh" });
        if (result?.status === 410) await deviceStore.removeDevice(device.deviceId);
      }));
    } catch { /* A missed hint never interrupts agent activity. A later change can retry. */ }
    finally { inFlight = false; if (dirty) changed(); }
  }
  function changed() {
    if (!enabled || !apnsClient || timer) return;
    dirty = true;
    if (inFlight) return;
    const delay = Math.max(0, MIN_INTERVAL_MS - (now() - lastSent));
    timer = schedule(flush, delay);
    timer?.unref?.();
  }
  return { changed };
}
