import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 30_000;

export type WorktreeInfo = {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
};

export async function createWorktree(params: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch?: string;
}): Promise<void> {
  const base = params.baseBranch ?? "origin/main";
  await execFileAsync("git", ["worktree", "add", params.worktreePath, "-b", params.branch, base], {
    cwd: params.repoRoot,
    timeout: EXEC_TIMEOUT_MS,
  });
}

export async function removeWorktree(params: {
  repoRoot: string;
  worktreePath: string;
  force?: boolean;
}): Promise<void> {
  const args = ["worktree", "remove", params.worktreePath];
  if (params.force) {
    args.push("--force");
  }
  await execFileAsync("git", args, {
    cwd: params.repoRoot,
    timeout: EXEC_TIMEOUT_MS,
  });
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    timeout: EXEC_TIMEOUT_MS,
  });
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? "",
          head: current.head ?? "",
          bare: current.bare ?? false,
        });
      }
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch ?? "",
      head: current.head ?? "",
      bare: current.bare ?? false,
    });
  }
  return worktrees;
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["worktree", "prune"], {
    cwd: repoRoot,
    timeout: EXEC_TIMEOUT_MS,
  });
}
