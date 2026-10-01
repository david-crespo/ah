// Running a command to completion and collecting its output, which is most of
// what ah does with subprocesses. Long-lived children (the Ghostty poller, the
// detached server) use node:child_process directly.

import { execFile, type ExecFileOptions } from "node:child_process"

export interface Output {
  success: boolean
  /** null when the process died from a signal */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run `cmd` and wait for it. Never throws for a nonzero exit, only when the
 * command can't be started at all (e.g. it isn't on PATH).
 */
export function run(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") return reject(error) // ENOENT etc.
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0
        resolve({ success: !error, code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}
