import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import type { SwarmTask, SwarmTaskStatus } from "./types.js";

type PersistedSwarmRegistry = {
  version: 1;
  tasks: Record<string, SwarmTask>;
};

const REGISTRY_VERSION = 1 as const;

const swarmTasks = new Map<string, SwarmTask>();
let restored = false;

function resolveRegistryPath(): string {
  return path.join(resolveStateDir(), "swarm", "tasks.json");
}

function restoreIfNeeded(): void {
  if (restored) {
    return;
  }
  restored = true;
  const raw = loadJsonFile(resolveRegistryPath());
  if (!raw || typeof raw !== "object") {
    return;
  }
  const record = raw as Partial<PersistedSwarmRegistry>;
  if (record.version !== 1 || !record.tasks || typeof record.tasks !== "object") {
    return;
  }
  for (const [taskId, entry] of Object.entries(record.tasks)) {
    if (!entry || typeof entry !== "object" || !entry.taskId) {
      continue;
    }
    swarmTasks.set(taskId, entry);
  }
}

function persist(): void {
  const serialized: Record<string, SwarmTask> = {};
  for (const [taskId, entry] of swarmTasks.entries()) {
    serialized[taskId] = entry;
  }
  const out: PersistedSwarmRegistry = { version: REGISTRY_VERSION, tasks: serialized };
  try {
    saveJsonFile(resolveRegistryPath(), out);
  } catch {
    // best-effort persistence
  }
}

export function registerSwarmTask(task: SwarmTask): void {
  restoreIfNeeded();
  swarmTasks.set(task.taskId, task);
  persist();
}

export function updateSwarmTask(
  taskId: string,
  patch: Partial<
    Pick<
      SwarmTask,
      | "status"
      | "endedAt"
      | "prNumber"
      | "prUrl"
      | "ciStatus"
      | "error"
      | "retryCount"
      | "startedAt"
    >
  >,
): SwarmTask | undefined {
  restoreIfNeeded();
  const task = swarmTasks.get(taskId);
  if (!task) {
    return undefined;
  }
  Object.assign(task, patch);
  persist();
  return task;
}

export function getSwarmTask(taskId: string): SwarmTask | undefined {
  restoreIfNeeded();
  return swarmTasks.get(taskId);
}

export function listSwarmTasks(): SwarmTask[] {
  restoreIfNeeded();
  return Array.from(swarmTasks.values());
}

export function listSwarmTasksByStatus(status: SwarmTaskStatus): SwarmTask[] {
  return listSwarmTasks().filter((t) => t.status === status);
}

export function listSwarmTasksForRequester(requesterSessionKey: string): SwarmTask[] {
  return listSwarmTasks().filter((t) => t.requesterSessionKey === requesterSessionKey);
}

export function removeSwarmTask(taskId: string): boolean {
  restoreIfNeeded();
  const removed = swarmTasks.delete(taskId);
  if (removed) {
    persist();
  }
  return removed;
}

export function countActiveSwarmTasks(): number {
  return listSwarmTasks().filter((t) => t.status === "running" || t.status === "pending").length;
}

/** Sweep tasks that ended more than maxAgeMs ago. */
export function sweepCompletedSwarmTasks(maxAgeMs: number = 24 * 60 * 60_000): number {
  restoreIfNeeded();
  const now = Date.now();
  let swept = 0;
  for (const [taskId, task] of swarmTasks.entries()) {
    if (task.endedAt && now - task.endedAt > maxAgeMs) {
      swarmTasks.delete(taskId);
      swept += 1;
    }
  }
  if (swept > 0) {
    persist();
  }
  return swept;
}
