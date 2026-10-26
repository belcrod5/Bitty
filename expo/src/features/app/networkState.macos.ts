export function addNetworkStateListener(_listener: () => void) {
  return { remove() {} };
}

export async function getNetworkStateAsync() {
  return { type: "UNKNOWN" };
}
