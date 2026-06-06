/**
 * Successful CLI command shutdown behavior.
 *
 * Output is flushed before model cleanup, then the event loop is allowed to
 * drain naturally so node-llama-cpp can dispose native resources safely.
 */

import { disposeDefaultLlamaCpp } from "../llm.js";
import type { OutputFormat } from "./formatter.js";

type CliLifecycleWritable = {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
};

export type FinishSuccessfulCliCommandOptions = {
  command: string;
  format?: OutputFormat;
  cleanup?: () => Promise<void>;
  exit?: (code: number) => void;
  stdout?: CliLifecycleWritable;
  stderr?: CliLifecycleWritable;
};

async function flushWritable(stream: CliLifecycleWritable): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write("", () => resolve());
  });
}

/**
 * Finish a successful command without calling `process.exit(0)`.
 *
 * Direct exit skips Node's `beforeExit` event and can leave native llama/ggml
 * resources alive. Tests may provide an explicit `exit` callback to verify the
 * legacy flush-cleanup-exit ordering.
 */
export async function finishSuccessfulCliCommand(options: FinishSuccessfulCliCommandOptions): Promise<void> {
  const stderr = options.stderr ?? process.stderr;

  await flushWritable(options.stdout ?? process.stdout);

  try {
    await (options.cleanup ?? disposeDefaultLlamaCpp)();
  } catch (error) {
    stderr.write(
      `QMD Warning: cleanup after successful output failed (${error instanceof Error ? error.message : String(error)}); exiting 0 because command output completed.\n`
    );
  }
  await flushWritable(stderr);

  if (options.exit) {
    options.exit(0);
    return;
  }

  process.exitCode = 0;
}
