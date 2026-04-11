import { spawn } from 'child_process';

export interface ClaudeRunResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;

export async function runClaudeExec(
  prompt: string,
  cwd: string,
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      prompt,
    ];

    const proc = spawn('claude', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: `Failed to start Claude: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        resolve({
          ok: false,
          error: 'Claude timed out before completing the task.',
        });
        return;
      }

      const cleanStderr = stderr.replace(/\x1b\[[0-9;]*m/g, '').trim();
      const cleanStdout = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();

      if (code !== 0) {
        resolve({
          ok: false,
          error:
            cleanStderr ||
            cleanStdout ||
            `Claude exited with code ${code === null ? 'unknown' : code}.`,
        });
        return;
      }

      resolve({
        ok: true,
        text: cleanStdout || 'Claude completed, but returned no final message.',
      });
    });
  });
}
