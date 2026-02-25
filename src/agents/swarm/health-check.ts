import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSwarmTasks, updateSwarmTask } from "./task-registry.js";
import { isTmuxSessionAlive } from "./tmux.js";
import type { SwarmHealthReport, SwarmTask } from "./types.js";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 15_000;

async function checkPrStatus(task: SwarmTask): Promise<{
  hasPr: boolean;
  prNumber?: number;
  ciStatus?: string;
}> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        task.worktreeBranch,
        "--json",
        "number,statusCheckRollup,url",
        "--limit",
        "1",
      ],
      { cwd: task.repoRoot, timeout: GH_TIMEOUT_MS },
    );
    const prs = JSON.parse(stdout) as Array<{
      number: number;
      url: string;
      statusCheckRollup?: Array<{ conclusion: string; status: string }>;
    }>;
    if (prs.length === 0) {
      return { hasPr: false };
    }
    const pr = prs[0];
    if (!pr) {
      return { hasPr: false };
    }
    const checks = pr.statusCheckRollup ?? [];
    let ciStatus = "unknown";
    if (checks.length > 0) {
      const allPassed = checks.every(
        (c) => c.conclusion === "SUCCESS" || c.conclusion === "success",
      );
      const anyFailed = checks.some(
        (c) => c.conclusion === "FAILURE" || c.conclusion === "failure",
      );
      const anyPending = checks.some((c) => c.status === "IN_PROGRESS" || c.status === "QUEUED");
      if (allPassed) {
        ciStatus = "passing";
      } else if (anyFailed) {
        ciStatus = "failing";
      } else if (anyPending) {
        ciStatus = "pending";
      }
    }
    return { hasPr: true, prNumber: pr.number, ciStatus };
  } catch {
    return { hasPr: false };
  }
}

export async function checkSwarmTaskHealth(task: SwarmTask): Promise<SwarmHealthReport> {
  const now = Date.now();
  const tmuxAlive = await isTmuxSessionAlive(task.tmuxSession);
  const prStatus = await checkPrStatus(task);

  // If tmux is dead and task is still "running", mark as done or failed
  if (!tmuxAlive && task.status === "running") {
    if (prStatus.hasPr) {
      updateSwarmTask(task.taskId, {
        status: "done",
        endedAt: now,
        prNumber: prStatus.prNumber,
        ciStatus: prStatus.ciStatus as "passing" | "failing" | "pending" | "unknown" | undefined,
      });
    } else {
      updateSwarmTask(task.taskId, {
        status: "failed",
        endedAt: now,
        error: "Agent process exited without creating a PR.",
      });
    }
  }

  // Update PR info for running tasks
  if (tmuxAlive && prStatus.hasPr) {
    updateSwarmTask(task.taskId, {
      prNumber: prStatus.prNumber,
      ciStatus: prStatus.ciStatus as "passing" | "failing" | "pending" | "unknown" | undefined,
    });
  }

  const updatedStatus =
    !tmuxAlive && task.status === "running" ? (prStatus.hasPr ? "done" : "failed") : task.status;

  return {
    taskId: task.taskId,
    label: task.label,
    tmuxAlive,
    hasPr: prStatus.hasPr,
    prNumber: prStatus.prNumber,
    ciStatus: prStatus.ciStatus,
    status: updatedStatus,
    runtimeMs: now - (task.startedAt ?? task.createdAt),
  };
}

export async function checkAllSwarmHealth(): Promise<SwarmHealthReport[]> {
  const tasks = listSwarmTasks();
  const activeTasks = tasks.filter((t) => t.status === "running" || t.status === "pending");
  const reports: SwarmHealthReport[] = [];
  for (const task of activeTasks) {
    const report = await checkSwarmTaskHealth(task);
    reports.push(report);
  }
  return reports;
}
