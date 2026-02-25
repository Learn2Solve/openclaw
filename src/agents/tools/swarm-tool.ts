import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import {
  captureTmuxOutput,
  checkAllSwarmHealth,
  checkSwarmTaskHealth,
  killSwarmAgent,
  listSwarmTasks,
  removeSwarmTask,
  respawnSwarmAgent,
  sendToTmuxSession,
  spawnSwarmAgent,
  sweepCompletedSwarmTasks,
} from "../swarm/index.js";
import type { SwarmConfig, SwarmTask } from "../swarm/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SWARM_ACTIONS = [
  "spawn",
  "list",
  "kill",
  "status",
  "steer",
  "logs",
  "respawn",
  "cleanup",
] as const;
const RUNNER_KINDS = ["claude-code", "codex", "gemini"] as const;

const SwarmToolSchema = Type.Object({
  action: stringEnum(SWARM_ACTIONS),
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  runner: optionalStringEnum(RUNNER_KINDS),
  model: Type.Optional(Type.String()),
  repoRoot: Type.Optional(Type.String()),
  baseBranch: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Number({ minimum: 1 })),
});

type SwarmToolOptions = {
  agentSessionKey?: string;
  config?: { tools?: { swarm?: SwarmConfig } };
  workspaceDir?: string;
};

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.floor(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)}m`;
  }
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatTaskLine(task: SwarmTask, index: number): string {
  const now = Date.now();
  const runtime = formatDuration(now - (task.startedAt ?? task.createdAt));
  const pr = task.prNumber ? ` PR#${task.prNumber}` : "";
  const ci = task.ciStatus ? ` CI:${task.ciStatus}` : "";
  const err = task.error ? ` err:${task.error.slice(0, 60)}` : "";
  const retry = task.retryCount > 0 ? ` retry:${task.retryCount}/${task.maxRetries}` : "";
  return `${index}. [${task.status}] ${task.label} (${task.runner}, ${runtime}${pr}${ci}${retry}${err}) - ${task.task.slice(0, 80)}`;
}

function resolveSwarmConfig(opts?: SwarmToolOptions): SwarmConfig {
  const cfg = loadConfig();
  return (cfg as Record<string, unknown>).tools &&
    typeof (cfg as Record<string, unknown>).tools === "object"
    ? ((cfg as { tools?: { swarm?: SwarmConfig } }).tools?.swarm ?? {})
    : (opts?.config?.tools?.swarm ?? {});
}

function resolveTarget(tasks: SwarmTask[], target: string): SwarmTask | undefined {
  // Try by taskId
  const byId = tasks.find((t) => t.taskId === target);
  if (byId) {
    return byId;
  }
  // Try by numeric index (1-based)
  const index = Number.parseInt(target, 10);
  if (Number.isFinite(index) && index >= 1 && index <= tasks.length) {
    return tasks[index - 1];
  }
  // Try by label prefix
  const lowerTarget = target.toLowerCase();
  const byLabel = tasks.filter((t) => t.label.toLowerCase().startsWith(lowerTarget));
  if (byLabel.length === 1) {
    return byLabel[0];
  }
  // Try by tmux session name
  const byTmux = tasks.find((t) => t.tmuxSession === target);
  return byTmux;
}

export function createSwarmTool(opts?: SwarmToolOptions): AnyAgentTool {
  return {
    label: "Swarm",
    name: "swarm",
    ownerOnly: true,
    description: `Manage external coding agents (Claude Code, Codex) running in isolated git worktrees with tmux sessions.

ACTIONS:
- spawn: Launch a new coding agent in its own worktree + tmux session
  Requires: task (the prompt/instruction for the agent)
  Optional: label, runner ("claude-code"|"codex"), model, repoRoot, baseBranch
- list: Show all tracked swarm agents with status
- kill: Terminate a running agent. Requires: target (taskId, index, label, or "all")
- status: Health check for one or all agents (tmux alive, PR status, CI). Optional: target
- steer: Send a message to a running agent via tmux. Requires: target, message
- logs: Capture recent tmux output from an agent. Requires: target. Optional: lines (default: 50)
- respawn: Restart a failed agent with the same or updated task. Requires: target. Optional: task (override)
- cleanup: Remove completed task entries and prune orphaned worktrees

RUNNERS:
- "claude-code": Uses \`claude --dangerously-skip-permissions -p "<task>"\`. Best for frontend, docs, git operations.
- "codex": Uses \`codex --full-auto "<task>"\`. Best for backend logic, complex bugs, multi-file refactors.
- "gemini": Uses \`gemini -p "<task>"\`. Best for UI design specs (HTML/CSS) that get handed to claude-code to implement.
Default runner is "claude-code" unless configured otherwise.

DESIGN PIPELINE PATTERN (Gemini -> Claude Code):
1. Spawn gemini agent: "Design a settings page with..." -> produces HTML/CSS spec
2. Spawn claude-code agent: "Implement this design in our component system: [spec from step 1]"

Each agent gets:
- An isolated git worktree branch (swarm/<label>-<id>)
- A tmux session (swarm-<id>) for process management
- Task tracking in the swarm registry with status, PR, and CI monitoring

NOTES:
- Use "list" first to see available targets before kill/steer/logs
- Target can be a taskId, 1-based index from list, label prefix, or tmux session name
- Health checks detect dead tmux sessions and update task status automatically
- Agents auto-create branches from origin/main (override with baseBranch)`,
    parameters: SwarmToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const swarmConfig = resolveSwarmConfig(opts);

      switch (action) {
        case "spawn": {
          const task = readStringParam(params, "task", { required: true });
          const label = readStringParam(params, "label");
          const runner = readStringParam(params, "runner") as "claude-code" | "codex" | undefined;
          const model = readStringParam(params, "model");
          const repoRoot =
            readStringParam(params, "repoRoot") ?? swarmConfig.repoRoot ?? opts?.workspaceDir;
          const baseBranch = readStringParam(params, "baseBranch");
          if (!repoRoot) {
            return jsonResult({
              status: "error",
              error:
                "repoRoot is required. Provide it as a parameter or configure tools.swarm.repoRoot.",
            });
          }
          const result = await spawnSwarmAgent({
            task,
            label,
            runner,
            model,
            repoRoot,
            baseBranch,
            requesterSessionKey: opts?.agentSessionKey ?? "unknown",
            config: swarmConfig,
          });
          return jsonResult(result);
        }

        case "list": {
          const tasks = listSwarmTasks();
          const now = Date.now();
          const active = tasks.filter((t) => t.status === "running" || t.status === "pending");
          const recent = tasks.filter(
            (t) =>
              t.status !== "running" &&
              t.status !== "pending" &&
              t.endedAt &&
              now - t.endedAt < 30 * 60_000,
          );

          let index = 1;
          const activeLines = active.map((t) => formatTaskLine(t, index++));
          const recentLines = recent.map((t) => formatTaskLine(t, index++));

          const text = [
            `active agents (${active.length}):`,
            ...(activeLines.length > 0 ? activeLines : ["(none)"]),
            "",
            `recent (last 30m, ${recent.length}):`,
            ...(recentLines.length > 0 ? recentLines : ["(none)"]),
          ].join("\n");

          return jsonResult({
            status: "ok",
            action: "list",
            totalActive: active.length,
            totalRecent: recent.length,
            totalAll: tasks.length,
            text,
          });
        }

        case "kill": {
          const target = readStringParam(params, "target", { required: true });
          if (target === "all" || target === "*") {
            const tasks = listSwarmTasks().filter(
              (t) => t.status === "running" || t.status === "pending",
            );
            let killed = 0;
            const labels: string[] = [];
            for (const task of tasks) {
              const result = await killSwarmAgent(task.taskId);
              if (result.killed) {
                killed += 1;
                labels.push(task.label);
              }
            }
            return jsonResult({
              status: "ok",
              action: "kill",
              target: "all",
              killed,
              labels,
              text:
                killed > 0
                  ? `Killed ${killed} agent${killed === 1 ? "" : "s"}.`
                  : "No running agents to kill.",
            });
          }
          const tasks = listSwarmTasks();
          const resolved = resolveTarget(tasks, target);
          if (!resolved) {
            return jsonResult({
              status: "error",
              action: "kill",
              target,
              error: `Unknown target: ${target}`,
            });
          }
          const result = await killSwarmAgent(resolved.taskId);
          return jsonResult({
            status: result.killed ? "ok" : "error",
            action: "kill",
            taskId: resolved.taskId,
            label: resolved.label,
            text: result.killed ? `Killed ${resolved.label}.` : (result.error ?? "Failed to kill."),
          });
        }

        case "status": {
          const target = readStringParam(params, "target");
          if (!target) {
            // Health check all active
            const reports = await checkAllSwarmHealth();
            const lines = reports.map(
              (r) =>
                `${r.label}: ${r.status} | tmux:${r.tmuxAlive ? "alive" : "dead"} | PR:${r.hasPr ? `#${r.prNumber}` : "none"} | CI:${r.ciStatus ?? "n/a"} | ${formatDuration(r.runtimeMs)}`,
            );
            return jsonResult({
              status: "ok",
              action: "status",
              reports,
              text: lines.length > 0 ? lines.join("\n") : "No active agents.",
            });
          }
          const tasks = listSwarmTasks();
          const resolved = resolveTarget(tasks, target);
          if (!resolved) {
            return jsonResult({
              status: "error",
              action: "status",
              target,
              error: `Unknown target: ${target}`,
            });
          }
          const report = await checkSwarmTaskHealth(resolved);
          return jsonResult({
            status: "ok",
            action: "status",
            report,
            text: `${report.label}: ${report.status} | tmux:${report.tmuxAlive ? "alive" : "dead"} | PR:${report.hasPr ? `#${report.prNumber}` : "none"} | CI:${report.ciStatus ?? "n/a"} | ${formatDuration(report.runtimeMs)}`,
          });
        }

        case "steer": {
          const target = readStringParam(params, "target", { required: true });
          const message = readStringParam(params, "message", { required: true });
          const tasks = listSwarmTasks();
          const resolved = resolveTarget(tasks, target);
          if (!resolved) {
            return jsonResult({
              status: "error",
              action: "steer",
              error: `Unknown target: ${target}`,
            });
          }
          if (resolved.status !== "running") {
            return jsonResult({
              status: "error",
              action: "steer",
              error: `Agent ${resolved.label} is ${resolved.status}, not running.`,
            });
          }
          const sent = await sendToTmuxSession(resolved.tmuxSession, message);
          return jsonResult({
            status: sent ? "ok" : "error",
            action: "steer",
            taskId: resolved.taskId,
            label: resolved.label,
            text: sent
              ? `Sent message to ${resolved.label}.`
              : `Failed to send to ${resolved.label}.`,
          });
        }

        case "logs": {
          const target = readStringParam(params, "target", { required: true });
          const lines = readNumberParam(params, "lines") ?? 50;
          const tasks = listSwarmTasks();
          const resolved = resolveTarget(tasks, target);
          if (!resolved) {
            return jsonResult({
              status: "error",
              action: "logs",
              error: `Unknown target: ${target}`,
            });
          }
          const output = await captureTmuxOutput(resolved.tmuxSession, lines);
          return jsonResult({
            status: output !== null ? "ok" : "error",
            action: "logs",
            taskId: resolved.taskId,
            label: resolved.label,
            text: output ?? `No output captured (tmux session may be dead).`,
          });
        }

        case "respawn": {
          const target = readStringParam(params, "target", { required: true });
          const overrideTask = readStringParam(params, "task");
          const tasks = listSwarmTasks();
          const resolved = resolveTarget(tasks, target);
          if (!resolved) {
            return jsonResult({
              status: "error",
              action: "respawn",
              error: `Unknown target: ${target}`,
            });
          }
          const result = await respawnSwarmAgent(resolved.taskId, overrideTask);
          return jsonResult({
            ...result,
            action: "respawn",
            label: resolved.label,
            text:
              result.status === "accepted"
                ? `Respawned ${resolved.label} (retry ${(resolved.retryCount ?? 0) + 1}/${resolved.maxRetries}).`
                : (result.error ?? "Respawn failed."),
          });
        }

        case "cleanup": {
          const swept = sweepCompletedSwarmTasks();
          // Also remove tasks where worktree was already cleaned up
          const tasks = listSwarmTasks();
          let removed = 0;
          for (const task of tasks) {
            if (task.status === "killed" || task.status === "failed") {
              if (task.endedAt && Date.now() - task.endedAt > 60 * 60_000) {
                removeSwarmTask(task.taskId);
                removed += 1;
              }
            }
          }
          return jsonResult({
            status: "ok",
            action: "cleanup",
            swept: swept + removed,
            text: `Cleaned up ${swept + removed} completed task${swept + removed === 1 ? "" : "s"}.`,
          });
        }

        default:
          return jsonResult({
            status: "error",
            error: `Unknown action: ${action}`,
          });
      }
    },
  };
}
