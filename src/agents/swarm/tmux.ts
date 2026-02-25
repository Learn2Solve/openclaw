import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 10_000;

export async function createTmuxSession(params: {
  sessionName: string;
  command: string;
  cwd: string;
}): Promise<void> {
  await execFileAsync(
    "tmux",
    ["new-session", "-d", "-s", params.sessionName, "-c", params.cwd, params.command],
    { timeout: EXEC_TIMEOUT_MS },
  );
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isTmuxSessionAlive(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function sendToTmuxSession(sessionName: string, text: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, text, "Enter"], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function captureTmuxOutput(
  sessionName: string,
  lines?: number,
): Promise<string | null> {
  try {
    const args = ["capture-pane", "-p", "-t", sessionName];
    if (lines && lines > 0) {
      args.push("-S", `-${lines}`);
    }
    const { stdout } = await execFileAsync("tmux", args, {
      timeout: EXEC_TIMEOUT_MS,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function listTmuxSessions(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
