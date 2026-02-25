export type SwarmRunnerKind = "claude-code" | "codex" | "gemini";

export type SwarmTaskStatus = "pending" | "running" | "done" | "failed" | "killed";

export type SwarmTask = {
  taskId: string;
  label: string;
  task: string;
  runner: SwarmRunnerKind;
  model?: string;
  status: SwarmTaskStatus;
  worktreePath: string;
  worktreeBranch: string;
  tmuxSession: string;
  repoRoot: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  prNumber?: number;
  prUrl?: string;
  ciStatus?: "pending" | "passing" | "failing" | "unknown";
  error?: string;
  retryCount: number;
  maxRetries: number;
  requesterSessionKey: string;
};

export type SwarmHealthReport = {
  taskId: string;
  label: string;
  tmuxAlive: boolean;
  hasPr: boolean;
  prNumber?: number;
  ciStatus?: string;
  status: SwarmTaskStatus;
  runtimeMs: number;
};

export type SwarmConfig = {
  enabled?: boolean;
  maxConcurrent?: number;
  defaultRunner?: SwarmRunnerKind;
  maxRetries?: number;
  repoRoot?: string;
};

export const SWARM_DEFAULTS = {
  maxConcurrent: 5,
  defaultRunner: "claude-code" as SwarmRunnerKind,
  maxRetries: 3,
} as const;
