import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import type {
  InspectProcmonExportInput,
  ProcmonExportReport,
} from "../../domain/captures/procmonExport.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  openRegularFile,
  RegularFileChangedError,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import {
  decodeProcmonExport,
  parseProcmonExport,
  ProcmonExportFormatError,
} from "./parseProcmonExport.js";

export const PROCMON_EXPORT_PROVIDER_IDENTITY = {
  id: "procmon-export",
  name: "REA Procmon export reader",
  version: "xml-csv@1",
} as const;

/** Largest export admitted into memory; the decoded text and events follow it. */
export const PROCMON_EXPORT_INPUT_BYTES = 64 * 1024 * 1024;

const OPERATION = "inspect_procmon_export";

class ExportTooLarge extends Error {}

/** Read one regular file once, verifying it did not change during the read. */
const readStable = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  const handle = await openRegularFile(path, { symlinks: "follow", signal });
  try {
    const initial = await handle.stat();
    if (initial.size > PROCMON_EXPORT_INPUT_BYTES) throw new ExportTooLarge();
    const bytes = Buffer.alloc(initial.size + 1);
    let position = 0;
    while (position < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
    }
    const [opened, named] = await Promise.all([handle.stat(), stat(path)]);
    if (
      position !== initial.size ||
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, named)
    )
      throw new RegularFileChangedError(path);
    return bytes.subarray(0, position);
  } finally {
    await handle.close();
  }
};

/** File-only Procmon XML/CSV export decoder. Never launches Procmon or any process. */
export class ProcmonExportReader {
  async inspect(
    input: InspectProcmonExportInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let bytes: Buffer;
    try {
      bytes = await readStable(input.path, options?.signal);
    } catch (cause) {
      return err(failure(input.path, cause, options?.signal));
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let parsed;
    try {
      parsed = parseProcmonExport(
        decodeProcmonExport(bytes),
        input.export_format,
      );
    } catch (cause) {
      if (cause instanceof ProcmonExportFormatError)
        return err(
          new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            `Not a supported Procmon ${input.export_format === "auto" ? "XML/CSV" : input.export_format.toUpperCase()} export: ${cause.reason}`,
            { cause },
          ),
        );
      throw cause;
    }
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const start = Math.min(input.event_offset, parsed.events.length);
    const end =
      input.event_limit === null
        ? parsed.events.length
        : Math.min(parsed.events.length, start + input.event_limit);
    const report: ProcmonExportReport = {
      artifact: { path: input.path, sha256, bytes: bytes.length },
      selection: input,
      format: parsed.format,
      columns: {
        source: [...parsed.columns.source],
        mapped: [...parsed.columns.mapped],
        missing: [...parsed.columns.missing],
        unmapped: [...parsed.columns.unmapped],
      },
      events: parsed.events.slice(start, end),
      coverage: {
        parsed_events: parsed.events.length,
        returned_events: end - start,
        has_more: end < parsed.events.length,
        status: parsed.status,
      },
      issues: [...parsed.issues],
      acquisition: "recorded-export-read-only",
    };
    return ok(
      createAnalysisExecution(report, PROCMON_EXPORT_PROVIDER_IDENTITY, {
        subject: { path: input.path, sha256, format: "file" },
        locations: [{ kind: "artifact-path", path: input.path }],
        limitations: [
          "Events are as recorded in a caller-supplied Procmon XML/CSV export. REA did not capture them, cannot verify the export was unfiltered, and cannot recover events dropped by Procmon filters, the export's column selection, or truncation.",
          "Columns absent from the export are reported in columns.missing and their values are null (unknown), not empty or absent activity. Time of Day is kept verbatim; exports carry no date or time zone.",
          "Only the documented XML/CSV export subset is read; PML logs, stacks and process-list details are not decoded. No Procmon, driver or other process is launched.",
          `Exports are capped at ${String(PROCMON_EXPORT_INPUT_BYTES)} bytes and read entirely into memory.`,
        ],
      }),
    );
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const failure = (
  path: string,
  cause: unknown,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof ExportTooLarge)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      `Export exceeds ${String(PROCMON_EXPORT_INPUT_BYTES)} bytes.`,
      { input_bytes: PROCMON_EXPORT_INPUT_BYTES },
      { cause },
    );
  if (cause instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(
      OPERATION,
      path,
      "Export changed while being read.",
      { cause },
    );
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
      cause,
    });
  return new AnalysisInputError(OPERATION, { cause }, [
    {
      path: ["path"],
      reason: "invalid_value",
      message: cause instanceof Error ? cause.message : String(cause),
    },
  ]);
};
