const RPC_TIMEOUT_MS = 8_000;

function timeout(promise, label, timeoutMs = RPC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function externalPayload(profile) {
  return {
    accessToken: profile.accessToken,
    chatgptAccountId: profile.chatgptAccountId,
    ...(profile.chatgptPlanType ? { chatgptPlanType: profile.chatgptPlanType } : {}),
  };
}

function authTokensParams(payload) {
  if (!payload?.accessToken || !payload?.chatgptAccountId) throw new Error("auth payload unavailable");
  return {
    type: "chatgptAuthTokens",
    accessToken: payload.accessToken,
    chatgptAccountId: payload.chatgptAccountId,
    ...(payload.chatgptPlanType ? { chatgptPlanType: payload.chatgptPlanType } : {}),
  };
}

function refreshResult(payload) {
  return externalPayload(payload);
}

export function createCodexAuthRuntime({ authService, createClient, rpcTimeoutMs = RPC_TIMEOUT_MS } = {}) {
  if (!authService || typeof createClient !== "function") throw new TypeError("authService and createClient are required");
  let activePayload = null;
  let activeAuthId = "";
  let ready = false;

  const inject = async (payload) => {
    const client = createClient({ authRefreshHandler: handleRefresh, bypassAuthGate: true });
    try {
      await timeout(client.openPromise, "Codex auth connection", rpcTimeoutMs);
      const initialize = await timeout(client.request("initialize", {
        clientInfo: { name: "bitty-auth-runtime", title: "Bitty Auth Runtime", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      }), "Codex initialize", rpcTimeoutMs);
      if (!initialize || typeof initialize !== "object") throw new Error("Codex initialize failed");
      client.notify("initialized", {});
      const login = await timeout(client.request("account/login/start", authTokensParams(payload)), "Codex auth injection", rpcTimeoutMs);
      if (!login || login.type !== "chatgptAuthTokens") throw new Error("Codex auth injection rejected");
      const account = await timeout(client.request("account/read", {}), "Codex account read", rpcTimeoutMs);
      const accountId = account?.account?.accountId || account?.account?.id || account?.accountId || account?.id;
      if (accountId && accountId !== payload.chatgptAccountId) throw new Error("Codex account mismatch");
      return externalPayload(payload);
    } finally {
      client.close();
    }
  };

  const handleRefresh = async (request) => {
    if (request?.params?.reason !== "unauthorized") throw new Error("auth refresh not allowed");
    const accountId = String(request?.params?.previousAccountId || "");
    if (!activePayload || accountId !== activePayload.chatgptAccountId) throw new Error("auth account mismatch");
    const refreshed = await timeout(authService.externalTokenPayload(activeAuthId, { forceRefresh: true }), "Codex auth refresh", rpcTimeoutMs);
    activePayload = externalPayload(refreshed);
    return refreshResult(activePayload);
  };

  const initialize = async () => {
    const payload = await authService.activeExternalTokenPayload();
    if (!payload) { activePayload = null; activeAuthId = ""; ready = true; return; }
    activeAuthId = await authService.activeAuthId();
    activePayload = await inject(payload);
    ready = true;
  };

  const switchAccount = async (authId) => authService.withSwitch(async () => {
    if (!ready) throw new Error("auth runtime unready");
    const previousAuthId = activeAuthId;
    await authService.closeAndDrain();
    try {
      const next = await authService.externalTokenPayload(authId);
      const injected = await inject(next);
      await authService.setActiveAuthId(authId);
      activeAuthId = authId;
      activePayload = injected;
      authService.openGate();
      return injected;
    } catch (error) {
      try {
        if (!previousAuthId) throw new Error("auth rollback unavailable");
        const previous = await authService.externalTokenPayload(previousAuthId);
        activePayload = await inject(previous);
        activeAuthId = previousAuthId;
        authService.openGate();
      } catch {
        ready = false;
        authService.markUnready();
      }
      throw error;
    }
  });

  return {
    initialize,
    switchAccount,
    handleRefresh,
    activePayload: () => activePayload && { ...activePayload },
    isReady: () => ready,
    inject,
  };
}
