import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

const DEFAULT_LIMIT_MINUTES = 60;

function utcMonth(date) {
  return date.toISOString().slice(0, 7);
}

function nextUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

function checkedLimitMinutes(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("monthlyLimitMinutes must be a positive integer");
  }
  return limit;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStoredProjects(projects) {
  for (const [projectId, project] of Object.entries(projects)) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
      || !isRecord(project) || !isRecord(project.months)) {
      throw new Error("Google Cloud usage ledger project record is invalid");
    }
    for (const [month, bucket] of Object.entries(project.months)) {
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || !isRecord(bucket)
        || !Number.isSafeInteger(bucket.usedSeconds) || bucket.usedSeconds < 0) {
        throw new Error("Google Cloud usage ledger bucket is invalid");
      }
    }
  }
}

export function createGoogleCloudUsageLedger({ filePath, getLimitMinutes, now = () => new Date(), fileSystem = fs }) {
  let queue = Promise.resolve();

  const ensureDirectory = async () => {
    const directory = path.dirname(filePath);
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fileSystem.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Google Cloud usage directory must be a directory");
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error("Google Cloud usage directory permissions must be 700");
    }
    return directory;
  };

  const serialized = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  const read = async () => {
    try {
      const stat = await fileSystem.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Google Cloud usage ledger must be a regular file");
      if ((stat.mode & 0o777) !== 0o600) throw new Error("Google Cloud usage ledger permissions must be 600");
      const data = JSON.parse(await fileSystem.readFile(filePath, "utf8"));
      if (!data || data.version !== 1 || !data.projects || typeof data.projects !== "object" || Array.isArray(data.projects)) {
        throw new Error("Google Cloud usage ledger is invalid");
      }
      validateStoredProjects(data.projects);
      return data;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  };

  const write = async (data) => {
    await ensureDirectory();
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    let committed = false;
    try {
      handle = await fileSystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fileSystem.rename(temporaryPath, filePath);
      await fileSystem.chmod(filePath, 0o600);
      committed = true;
    } finally {
      await handle?.close().catch(() => {});
      if (!committed) await fileSystem.unlink(temporaryPath).catch(() => {});
    }
  };

  const bucketFor = (data, projectId, limitMinutes, date) => {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(projectId || ""))) {
      throw new Error("projectId is invalid");
    }
    const month = utcMonth(date);
    const project = data.projects[projectId] ||= { months: {} };
    if (!isRecord(project) || !isRecord(project.months)) {
      throw new Error("Google Cloud usage ledger project record is invalid");
    }
    const bucket = project.months[month] ||= {
      usedSeconds: 0,
      limitSeconds: limitMinutes * 60,
      updatedAt: date.toISOString(),
    };
    if (!isRecord(bucket) || !Number.isSafeInteger(bucket.usedSeconds) || bucket.usedSeconds < 0) {
      throw new Error("Google Cloud usage ledger bucket is invalid");
    }
    bucket.limitSeconds = limitMinutes * 60;
    return { month, bucket };
  };

  const snapshot = (projectId, month, bucket, date) => ({
    projectId,
    monthUtc: month,
    usedSeconds: Math.max(0, Number(bucket.usedSeconds) || 0),
    limitSeconds: Math.max(60, Number(bucket.limitSeconds) || DEFAULT_LIMIT_MINUTES * 60),
    remainingSeconds: Math.max(0, (Number(bucket.limitSeconds) || 0) - (Number(bucket.usedSeconds) || 0)),
    resetAt: nextUtcMonth(date),
  });

  return {
    initialize() {
      return serialized(async () => {
        await ensureDirectory();
        await read();
      });
    },

    get(projectId) {
      return serialized(async () => {
        const date = now();
        const limit = checkedLimitMinutes(await getLimitMinutes());
        const data = await read();
        const { month, bucket } = bucketFor(data, projectId, limit, date);
        await write(data);
        return snapshot(projectId, month, bucket, date);
      });
    },

    reserve(projectId, seconds) {
      return serialized(async () => {
        const requested = Number(seconds);
        if (!Number.isSafeInteger(requested) || requested <= 0) {
          throw new Error("usage reservation seconds must be a positive integer");
        }
        const date = now();
        const limit = checkedLimitMinutes(await getLimitMinutes());
        const data = await read();
        const { month, bucket } = bucketFor(data, projectId, limit, date);
        if (bucket.usedSeconds + requested > bucket.limitSeconds) {
          return { reserved: false, ...snapshot(projectId, month, bucket, date) };
        }
        bucket.usedSeconds += requested;
        bucket.updatedAt = date.toISOString();
        await write(data);
        return { reserved: true, ...snapshot(projectId, month, bucket, date) };
      });
    },
  };
}
