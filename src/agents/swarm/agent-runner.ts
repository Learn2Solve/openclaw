import crypto from "node:crypto";
import path from "node:path";
import {
  countActiveSwarmTasks,
  getSwarmTask,
  registerSwarmTask,
  updateSwarmTask,
} from "./task-registry.js";
import { createTmuxSession, isTmuxSessionAlive, killTmuxSession } from "./tmux.js";
import type { SwarmConfig, SwarmRunnerKind, SwarmTask } from "./types.js";
import { SWARM_DEFAULTS } from "./types.js";
import { createWorktree, removeWorktree } from "./worktree.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function buildRunnerCommand(params: {
  runner: SwarmRunnerKind;
  task: string;
  model?: string;
}): string {
  const escapedTask = params.task.replace(/'/g, "'\\''");
  switch (params.runner) {
    case "claude-code":
      return [
        "claude",
        params.model ? `--model ${params.model}` : "",
        "--dangerously-skip-permissions",
        `-p '${escapedTask}'`,
      ]
        .filter(Boolean)
        .join(" ");
    case "codex":
      return [
        "codex",
        params.model ? `--model ${params.model}` : "",
        "--full-auto",
        `'${escapedTask}'`,
      ]
        .filter(Boolean)
        .join(" ");
    case "gemini":
      return ["gemini", params.model ? `--model ${params.model}` : "", `-p '${escapedTask}'`]
        .filter(Boolean)
        .join(" ");
    default: {
      const unknown: never = params.runner;
      throw new Error(`Unknown runner: ${String(unknown)}`);
    }
  }
}

export type SpawnSwarmAgentParams = {
  task: string;
  label?: string;
  runner?: SwarmRunnerKind;
  model?: string;
  repoRoot: string;
  baseBranch?: string;
  requesterSessionKey: string;
  config?: SwarmConfig;
};

export type SpawnSwarmAgentResult = {
  status: "accepted" | "error" | "limit_reached";
  taskId?: string;
  tmuxSession?: string;
  branch?: string;
  worktreePath?: string;
  error?: string;
};

export async function spawnSwarmAgent(
  params: SpawnSwarmAgentParams,
): Promise<SpawnSwarmAgentResult> {
  const config = params.config ?? {};
  const maxConcurrent = config.maxConcurrent ?? SWARM_DEFAULTS.maxConcurrent;
  const runner = params.runner ?? config.defaultRunner ?? SWARM_DEFAULTS.defaultRunner;
  const maxRetries = config.maxRetries ?? SWARM_DEFAULTS.maxRetries;

  const activeCount = countActiveSwarmTasks();
  if (activeCount >= maxConcurrent) {
    return {
      status: "limit_reached",
      error: `Max concurrent agents reached (${activeCount}/${maxConcurrent}).`,
    };
  }

  const taskId = crypto.randomUUID().slice(0, 8);
  const label = params.label?.trim() || `task-${taskId}`;
  const slug = slugify(label);
  const branch = `swarm/${slug}-${taskId}`;
  const tmuxSession = `swarm-${taskId}`;
  const worktreePath = path.resolve(
    params.repoRoot,
    "..",
    `${path.basename(params.repoRoot)}-swarm-${slug}-${taskId}`,
  );

  // 1. Create worktree
  try {
    await createWorktree({
      repoRoot: params.repoRoot,
      worktreePath,
      branch,
      baseBranch: params.baseBranch,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: `Failed to create worktree: ${msg}` };
  }

  // 2. Build and launch the runner in tmux
  const command = buildRunnerCommand({
    runner,
    task: params.task,
    model: params.model,
  });

  try {
    await createTmuxSession({
      sessionName: tmuxSession,
      command,
      cwd: worktreePath,
    });
  } catch (err) {
    // Clean up worktree on tmux failure
    try {
      await removeWorktree({ repoRoot: params.repoRoot, worktreePath, force: true });
    } catch {
      // best effort
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: `Failed to create tmux session: ${msg}` };
  }

  // 3. Register task
  const task: SwarmTask = {
    taskId,
    label,
    task: params.task,
    runner,
    model: params.model,
    status: "running",
    worktreePath,
    worktreeBranch: branch,
    tmuxSession,
    repoRoot: params.repoRoot,
    createdAt: Date.now(),
    startedAt: Date.now(),
    retryCount: 0,
    maxRetries,
    requesterSessionKey: params.requesterSessionKey,
  };

  registerSwarmTask(task);

  return {
    status: "accepted",
    taskId,
    tmuxSession,
    branch,
    worktreePath,
  };
}

export async function killSwarmAgent(
  taskId: string,
  options?: { removeWorktreeFlag?: boolean },
): Promise<{ killed: boolean; error?: string }> {
  const task = getSwarmTask(taskId);
  if (!task) {
    return { killed: false, error: "Task not found." };
  }

  if (task.status !== "running" && task.status !== "pending") {
    return { killed: false, error: `Task already ${task.status}.` };
  }

  // Kill tmux
  await killTmuxSession(task.tmuxSession);

  // Update status
  updateSwarmTask(taskId, {
    status: "killed",
    endedAt: Date.now(),
  });

  // Optionally remove worktree
  if (options?.removeWorktreeFlag) {
    try {
      await removeWorktree({
        repoRoot: task.repoRoot,
        worktreePath: task.worktreePath,
        force: true,
      });
    } catch {
      // best effort
    }
  }

  return { killed: true };
}

export async function respawnSwarmAgent(
  taskId: string,
  overrideTask?: string,
): Promise<SpawnSwarmAgentResult> {
  const task = getSwarmTask(taskId);
  if (!task) {
    return { status: "error", error: "Task not found." };
  }

  if (task.retryCount >= task.maxRetries) {
    return {
      status: "error",
      error: `Max retries reached (${task.retryCount}/${task.maxRetries}).`,
    };
  }

  // Kill existing tmux if still alive
  const alive = await isTmuxSessionAlive(task.tmuxSession);
  if (alive) {
    await killTmuxSession(task.tmuxSession);
  }

  // Relaunch in same worktree
  const command = buildRunnerCommand({
    runner: task.runner,
    task: overrideTask ?? task.task,
    model: task.model,
  });

  try {
    await createTmuxSession({
      sessionName: task.tmuxSession,
      command,
      cwd: task.worktreePath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSwarmTask(taskId, {
      status: "failed",
      endedAt: Date.now(),
      error: `Respawn failed: ${msg}`,
    });
    return { status: "error", error: `Respawn failed: ${msg}` };
  }

  updateSwarmTask(taskId, {
    status: "running",
    retryCount: task.retryCount + 1,
    startedAt: Date.now(),
    error: undefined,
  });

  return {
    status: "accepted",
    taskId,
    tmuxSession: task.tmuxSession,
    branch: task.worktreeBranch,
    worktreePath: task.worktreePath,
  };
}
