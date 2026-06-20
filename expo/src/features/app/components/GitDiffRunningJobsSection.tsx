import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Alert,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { styles } from "../styles";
import { startRunnerShellScript } from "../utils/runnerFileContextMenu";

type ScriptJobStatus = "running" | "stopping" | "completed" | "failed" | "killed" | "timed_out";
type ScriptJob = {
  jobId: string;
  path: string;
  cwd: string;
  pid: number;
  status: ScriptJobStatus;
  timeoutMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  killRequested: boolean;
  killReason: string;
};
type JsonRecord = Record<string, unknown>;

type GitDiffRunningJobsSectionProps = {
  active: boolean;
  runnerUrl: string;
  runnerToken: string;
  refreshSignal: number;
  showInfoToast: (textRaw: unknown) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function GitDiffRunningJobsSection({
  active,
  runnerUrl,
  runnerToken,
  refreshSignal,
  showInfoToast,
  onLoadingChange,
}: GitDiffRunningJobsSectionProps) {
  const [runningScriptJobs, setRunningScriptJobs] = useState<ScriptJob[]>([]);
  const [runningScriptJobsLoading, setRunningScriptJobsLoading] = useState(false);
  const [runningScriptJobsError, setRunningScriptJobsError] = useState("");
  const [runningScriptJobsNowTick, setRunningScriptJobsNowTick] = useState(0);

  useEffect(() => {
    onLoadingChange?.(runningScriptJobsLoading);
  }, [onLoadingChange, runningScriptJobsLoading]);

  const fetchRunningScriptJobs = useCallback(async () => {
    const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
    const token = String(runnerToken || "").trim();
    if (!baseUrl || !token) {
      throw new Error("Runner URL または Runner Token が未設定です");
    }
    const response = await fetch(`${baseUrl}/scripts/jobs`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const text = await response.text();
    let data: JsonRecord = {};
    try {
      data = text ? JSON.parse(text) as JsonRecord : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return jobs.map((jobRaw: unknown): ScriptJob => {
      const job = jobRaw && typeof jobRaw === "object" ? jobRaw as JsonRecord : {};
      return {
        jobId: String(job.jobId || "").trim(),
        path: String(job.path || "").trim(),
        cwd: String(job.cwd || ".").trim() || ".",
        pid: Number(job.pid || 0),
        status: String(job.status || "").trim() as ScriptJobStatus,
        timeoutMs: Number(job.timeoutMs || 0),
        startedAtMs: Number(job.startedAtMs || 0),
        finishedAtMs: Number(job.finishedAtMs || 0),
        durationMs: Number(job.durationMs || 0),
        exitCode: Number.isFinite(Number(job.exitCode)) ? Number(job.exitCode) : null,
        timedOut: Boolean(job.timedOut),
        killRequested: Boolean(job.killRequested),
        killReason: String(job.killReason || "").trim(),
      };
    });
  }, [runnerToken, runnerUrl]);

  const reloadRunningScriptJobs = useCallback(async () => {
    setRunningScriptJobsLoading(true);
    setRunningScriptJobsError("");
    try {
      const jobs = await fetchRunningScriptJobs();
      setRunningScriptJobs(jobs);
    } catch (err) {
      setRunningScriptJobsError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningScriptJobsLoading(false);
    }
  }, [fetchRunningScriptJobs]);

  const scheduleRunningScriptJobsBurstRefresh = useCallback(() => {
    const delays = [120, 320, 620, 980, 1400];
    for (const delayMs of delays) {
      setTimeout(() => {
        void fetchRunningScriptJobs()
          .then((jobs) => {
            setRunningScriptJobs(jobs);
            setRunningScriptJobsError("");
          })
          .catch((err) => {
            setRunningScriptJobsError(err instanceof Error ? err.message : String(err));
          });
      }, delayMs);
    }
  }, [fetchRunningScriptJobs]);

  const killRunningScriptJob = useCallback(async (jobIdRaw: unknown) => {
    const jobId = String(jobIdRaw || "").trim();
    const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
    const token = String(runnerToken || "").trim();
    if (!jobId) {
      throw new Error("jobId が未指定です");
    }
    if (!baseUrl || !token) {
      throw new Error("Runner URL または Runner Token が未設定です");
    }
    const response = await fetch(`${baseUrl}/scripts/kill`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobId }),
    });
    const text = await response.text();
    let data: JsonRecord = {};
    try {
      data = text ? JSON.parse(text) as JsonRecord : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      ok: Boolean(data?.ok),
      status: String(data?.status || "").trim(),
      running: Boolean(data?.running),
    };
  }, [runnerToken, runnerUrl]);

  useEffect(() => {
    if (!active) return;
    void reloadRunningScriptJobs();
    const timer = setInterval(() => {
      void fetchRunningScriptJobs()
        .then((jobs) => {
          setRunningScriptJobs(jobs);
          setRunningScriptJobsError("");
        })
        .catch((err) => {
          setRunningScriptJobsError(err instanceof Error ? err.message : String(err));
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [active, fetchRunningScriptJobs, reloadRunningScriptJobs]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setRunningScriptJobsNowTick((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || refreshSignal <= 0) return;
    void reloadRunningScriptJobs();
  }, [active, refreshSignal, reloadRunningScriptJobs]);

  const formatDurationMsLabel = useCallback((durationMsRaw: unknown) => {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMsRaw || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }, []);

  const openRunningJobContextMenu = useCallback((jobRaw: ScriptJob) => {
    const job = jobRaw;
    if (!job || !job.jobId) return;
    const canKill = job.status === "running";
    const title = job.path || job.jobId;
    const detailLines = [
      `jobId: ${job.jobId}`,
      `status: ${job.status}`,
      `pid: ${job.pid || "-"}`,
    ];
    const killAction = () => {
      Alert.alert("停止確認", `${title} を停止しますか？`, [
        { text: "キャンセル", style: "cancel" },
        {
          text: "停止する",
          style: "destructive",
          onPress: () => {
            void killRunningScriptJob(job.jobId)
              .then(() => {
                showInfoToast(`停止要求を送信: ${title}`);
                setRunningScriptJobs((prev) => prev.map((entry) => (
                  entry.jobId === job.jobId
                    ? { ...entry, status: "stopping", killRequested: true, killReason: "manual" }
                    : entry
                )));
                scheduleRunningScriptJobsBurstRefresh();
              })
              .catch((err) => {
                Alert.alert("停止失敗", err instanceof Error ? err.message : String(err));
              });
          },
        },
      ]);
    };
    const rerunAction = () => {
      Alert.alert("再実行確認", `${title} を再実行しますか？`, [
        { text: "キャンセル", style: "cancel" },
        {
          text: "再実行する",
          onPress: () => {
            void startRunnerShellScript({
              runnerUrl,
              runnerToken,
              path: job.path,
              allowExternal: job.path.startsWith("/"),
            })
              .then((result) => {
                if (!result.ok) {
                  Alert.alert("再実行失敗", "スクリプトの起動に失敗しました。");
                  return;
                }
                showInfoToast(`再実行開始: ${title} (${result.jobId || "job"})`);
                scheduleRunningScriptJobsBurstRefresh();
              })
              .catch((err) => {
                Alert.alert("再実行失敗", err instanceof Error ? err.message : String(err));
              });
          },
        },
      ]);
    };
    const buttons: Array<{
      text: string;
      style?: "default" | "cancel" | "destructive";
      onPress?: () => void;
    }> = [{ text: "再実行する", onPress: rerunAction }];
    if (canKill) {
      buttons.push({ text: "停止する", style: "destructive", onPress: killAction });
    }
    buttons.push({ text: "閉じる", style: "cancel" });
    Alert.alert(title, detailLines.join("\n"), buttons);
  }, [
    killRunningScriptJob,
    runnerToken,
    runnerUrl,
    scheduleRunningScriptJobsBurstRefresh,
    showInfoToast,
  ]);

  const renderRunningScriptJobRow = useCallback((job: ScriptJob): ReactElement => {
    const startedAtMs = Number(job?.startedAtMs || 0);
    const finishedAtMs = Number(job?.finishedAtMs || 0);
    const elapsedMs = finishedAtMs > 0
      ? Math.max(0, finishedAtMs - startedAtMs)
      : Math.max(0, Date.now() - startedAtMs + (runningScriptJobsNowTick * 0));
    const statusTextMap: Record<string, string> = {
      running: "実行中",
      stopping: "停止要求中",
      completed: "完了",
      failed: "失敗",
      killed: "停止",
      timed_out: "タイムアウト",
    };
    const statusText = statusTextMap[String(job.status || "")] || String(job.status || "-");
    const statusStyle = job.status === "running"
      ? styles.gitDiffRunningJobStatusRunning
      : (
        job.status === "stopping"
          ? styles.gitDiffRunningJobStatusStopping
          : (job.status === "completed" ? styles.gitDiffRunningJobStatusCompleted : styles.gitDiffRunningJobStatusFailed)
      );
    return (
      <TouchableOpacity
        key={job.jobId}
        style={styles.gitDiffRunningJobRow}
        onPress={() => openRunningJobContextMenu(job)}
        accessibilityRole="button"
        accessibilityLabel={`${job.path} (${statusText})`}
      >
        <View style={styles.gitDiffRunningJobRowHead}>
          <Text style={styles.gitDiffRunningJobPath} numberOfLines={1}>{job.path}</Text>
          <Text style={[styles.gitDiffRunningJobStatus, statusStyle]}>{statusText}</Text>
        </View>
        <Text style={styles.gitDiffRunningJobMeta}>
          {`pid: ${job.pid || "-"} | 経過: ${formatDurationMsLabel(elapsedMs)} | exit: ${job.exitCode ?? "-"}`}
        </Text>
        <Text style={styles.gitDiffRunningJobMeta} numberOfLines={1}>
          {`cwd: ${job.cwd || "."}`}
        </Text>
        <Text style={styles.gitDiffRunningJobHint}>タップでメニュー</Text>
      </TouchableOpacity>
    );
  }, [formatDurationMsLabel, openRunningJobContextMenu, runningScriptJobsNowTick]);

  return (
    <View style={styles.gitDiffSectionCard}>
      <Text style={styles.gitDiffSectionTitle}>{`実行ジョブ (${runningScriptJobs.length})`}</Text>
      <Text style={styles.gitDiffSectionHint}>この画面から起動した .sh の実行状態</Text>
      {runningScriptJobsLoading ? (
        <View style={styles.gitDiffPanelStatusRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.gitDiffPanelStatusText}>読み込み中...</Text>
        </View>
      ) : null}
      {runningScriptJobsError ? (
        <Text style={styles.gitDiffPanelErrorText}>{runningScriptJobsError}</Text>
      ) : null}
      {runningScriptJobs.length > 0 ? (
        <View style={styles.gitDiffRunningJobList}>
          {runningScriptJobs.map((job) => renderRunningScriptJobRow(job))}
        </View>
      ) : (
        <Text style={styles.gitDiffEmptyText}>実行中/履歴ジョブはありません</Text>
      )}
    </View>
  );
}
