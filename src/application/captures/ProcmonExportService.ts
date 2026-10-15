import { isAbsolute } from "node:path";

import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  inspectProcmonExportInputSchema,
  procmonExportSchema,
  type InspectProcmonExportInput,
} from "../../domain/captures/procmonExport.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

export interface ProcmonExportPort {
  inspect(
    input: InspectProcmonExportInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  close(): Promise<void>;
}

/** One shared validation and Evidence owner for CLI and MCP Procmon export reads. */
export class ProcmonExportService {
  constructor(readonly reader: ProcmonExportPort) {}
  close(): Promise<void> {
    return this.reader.close();
  }
  async inspect(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_procmon_export";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectProcmonExportInputSchema.safeParse(raw);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, raw, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute local path.",
          },
        ]),
      );
    const decoded = await this.reader.inspect(input.data, options);
    if (!decoded.ok) return decoded;
    const execution = decoded.value;
    const report = procmonExportSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      execution.subject?.path !== input.data.path ||
      execution.subject.sha256 !== report.data.artifact.sha256 ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.data)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Procmon export reader returned malformed data or changed the selected artifact identity/options.",
        ),
      );
    const evidence = createEvidence(execution.subject, execution.provider, {
      operation,
      parameters: input.data,
      result: execution.result,
      confidence: "observed",
      locations: execution.locations,
      limitations: execution.limitations,
    });
    return options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(operation, {
            partialObservation: evidence,
          }),
        )
      : ok(evidence);
  }
}
