/**
 * 原生目录选择器（stoa-session-ux design §3）。
 *
 * daemon 进程在宿主侧弹系统对话框（macOS osascript / Linux zenity·kdialog /
 * Windows PowerShell FolderBrowserDialog），把选中的绝对路径回给控制台。
 * 用户取消 → `{ok:true, path:null}`；没有可用对话框 → `{ok:false, error}`（前端保留手输）。
 *
 * 测试钩子：`STOA_DIR_PICKER_RESULT` 存在时直接返回其值（空串＝取消），仅供自动化验收。
 */
import { spawn } from "node:child_process";

export interface PickCommand {
  cmd: string;
  args: string[];
}

export interface PickResult {
  ok: boolean;
  path?: string | null;
  error?: string;
}

const DEFAULT_PROMPT = "选择 Stoa 数据目录";

/** 各平台的对话框命令（纯函数，便于单测）。 */
export function pickerCommand(platform: string, prompt = DEFAULT_PROMPT): PickCommand | null {
  if (platform === "darwin") {
    const escaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      cmd: "osascript",
      args: ["-e", `POSIX path of (choose folder with prompt "${escaped}")`],
    };
  }
  if (platform === "linux") {
    return { cmd: "zenity", args: ["--file-selection", "--directory", `--title=${prompt}`] };
  }
  if (platform === "win32") {
    const escaped = prompt.replace(/'/g, "''");
    return {
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
          `$f.Description = '${escaped}';`,
          "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
        ].join(" "),
      ],
    };
  }
  return null;
}

export function pickerSupported(platform = process.platform): boolean {
  return pickerCommand(platform) !== null;
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

async function run(command: PickCommand, timeoutMs: number): Promise<RunOutcome> {
  return await new Promise<RunOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let missing = false;
    const child = spawn(command.cmd, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, missing });
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** 用户取消的识别：osascript -128 / zenity 1 / 空输出都按取消处理（不报错）。 */
function isCancel(outcome: RunOutcome): boolean {
  if (outcome.missing) return false;
  const text = `${outcome.stdout}\n${outcome.stderr}`.toLowerCase();
  if (text.includes("user canceled") || text.includes("cancel")) return true;
  return outcome.code !== 0 && outcome.stdout.trim() === "";
}

export async function pickDirectory(opts: { prompt?: string; timeoutMs?: number } = {}): Promise<PickResult> {
  const hook = process.env.STOA_DIR_PICKER_RESULT;
  if (hook !== undefined) {
    const path = hook.trim();
    return { ok: true, path: path || null };
  }
  const command = pickerCommand(process.platform, opts.prompt);
  if (!command) {
    return { ok: false, error: `directory picker is not supported on ${process.platform}` };
  }
  const timeoutMs = opts.timeoutMs ?? 300_000;
  let outcome = await run(command, timeoutMs);
  // Linux 没有 zenity 时回退 kdialog。
  if (outcome.missing && process.platform === "linux") {
    outcome = await run(
      { cmd: "kdialog", args: ["--getexistingdirectory", process.env.HOME ?? "."] },
      timeoutMs,
    );
  }
  if (outcome.missing) {
    return {
      ok: false,
      error: `no directory dialog available (${command.cmd} not found); type the path manually`,
    };
  }
  if (isCancel(outcome)) return { ok: true, path: null };
  if (outcome.code !== 0) {
    return {
      ok: false,
      error: `${command.cmd} failed (exit ${outcome.code ?? "null"}): ${outcome.stderr.trim().slice(0, 400)}`,
    };
  }
  const path = outcome.stdout.trim().replace(/\/+$/, "");
  if (!path) return { ok: true, path: null };
  return { ok: true, path };
}
