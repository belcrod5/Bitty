import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AppState } from "react-native";
import { clearSecureRunnerSession } from "../utils/secureRunnerCredentials";
import { isRunnerSessionToken, requestRunnerLogin, RunnerLoginError, type RunnerSession } from "../utils/runnerLogin";
import { runnerConnectionIdentity } from "../../runnerWs/runnerConnectionIdentity";

export function useRunnerSessionLifecycle({ settingsLoaded, runnerUrl, runnerToken, localRunnerUrl = "", cloudflareRunnerUrl = "", setRunnerToken, onLoginRequired }: {
  settingsLoaded: boolean;
  runnerUrl: string;
  runnerToken: string;
  localRunnerUrl?: string;
  cloudflareRunnerUrl?: string;
  setRunnerToken: Dispatch<SetStateAction<string>>;
  onLoginRequired: () => void;
}) {
  // A paired Runner keeps its proof when only the selected transport route changes.
  const identity = JSON.stringify([runnerConnectionIdentity(runnerUrl, runnerToken, localRunnerUrl, cloudflareRunnerUrl), localRunnerUrl, cloudflareRunnerUrl]);
  const current = useRef({ runnerUrl, runnerToken, identity, onLoginRequired });
  current.current = { runnerUrl, runnerToken, identity, onLoginRequired };
  const invalidating = useRef("");
  const [proof, setProof] = useState<{ identity: string; expiresAt: number } | null>(null);
  const onSessionInvalid = useCallback((token: string) => {
    if (token !== current.current.runnerToken || invalidating.current === token) return;
    invalidating.current = token;
    setProof(null);
    // Block in-memory clients immediately; the conditional Keychain deletion is
    // serialized with saves so a later login can never be deleted by this response.
    setRunnerToken((value) => value === token ? "" : value);
    current.current.onLoginRequired();
    void clearSecureRunnerSession(token).catch(() => {
      console.warn("[auth] session cleanup failed; login remains required");
    }).finally(() => { if (invalidating.current === token) invalidating.current = ""; });
  }, [setRunnerToken]);

  const verifying = useRef<{ identity: string; url: string; promise: Promise<void> } | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifySession = useCallback(() => {
    const snapshot = { ...current.current };
    if (verifying.current?.identity === snapshot.identity && verifying.current.url === snapshot.runnerUrl) return verifying.current.promise;
    if (!isRunnerSessionToken(snapshot.runnerToken) || !snapshot.runnerUrl) return Promise.resolve();
    const operation = requestRunnerLogin<RunnerSession>(snapshot.runnerUrl, "/auth/session", { token: snapshot.runnerToken })
      .then((session) => {
        if (current.current.identity !== snapshot.identity || current.current.runnerUrl !== snapshot.runnerUrl) return;
        const expiresAt = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { setProof(null); return; }
        const proofExpiresAt = Math.min(expiresAt, Date.now() + 7 * 24 * 60 * 60 * 1000);
        setProof({ identity: snapshot.identity, expiresAt: proofExpiresAt });
        if (expiryTimer.current) clearTimeout(expiryTimer.current);
        expiryTimer.current = setTimeout(() => {
          expiryTimer.current = null;
          if (current.current.identity !== snapshot.identity) return;
          setProof(null);
          if (Date.now() >= expiresAt) onSessionInvalid(snapshot.runnerToken);
          else void verifySession();
        }, Math.max(0, proofExpiresAt - Date.now()));
      }).catch((reason) => {
        if (current.current.identity !== snapshot.identity) return;
        if (reason instanceof RunnerLoginError && reason.status === 401 && reason.code === "authentication_required") {
          onSessionInvalid(snapshot.runnerToken);
        }
      }).finally(() => { if (verifying.current?.promise === operation) verifying.current = null; });
    verifying.current = { identity: snapshot.identity, url: snapshot.runnerUrl, promise: operation };
    return operation;
  }, [onSessionInvalid]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (!isRunnerSessionToken(runnerToken)) current.current.onLoginRequired();
    else void verifySession();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void verifySession(); });
    return () => subscription.remove();
  }, [settingsLoaded, runnerUrl, runnerToken, identity, verifySession]);
  useEffect(() => () => { if (expiryTimer.current) clearTimeout(expiryTimer.current); }, []);
  const verified = settingsLoaded && proof?.identity === identity && proof.expiresAt > Date.now();
  return { onSessionInvalid, verifySession, verified: Boolean(verified) };
}
