import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";

import type { ProcmonExportService } from "../application/captures/ProcmonExportService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createProcmonExportService } from "../composition/captures.js";
import { inspectProcmonExportInputSchema } from "../domain/captures/procmonExport.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";

/** Read recorded Procmon XML/CSV exports through the shared Evidence service. */
export const registerProcmonCommands = (
  cli: CliInstance,
  logger: Logger,
  service: Pick<
    ProcmonExportService,
    "inspect" | "close"
  > = createProcmonExportService(),
): void => {
  cli.command(CLI_COMMANDS.inspectProcmonExport, {
    description:
      "Read recorded events from an existing Procmon XML or CSV export (file only)",
    args: z.object({
      path: z.string().describe("Local Procmon XML or CSV export"),
    }),
    options: z
      .object({
        ...inspectProcmonExportInputSchema.omit({
          path: true,
          event_limit: true,
        }).shape,
        event_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Events per page; default 200"),
        all_events: z
          .boolean()
          .default(false)
          .describe("Return all remaining events instead of a bounded page"),
      })
      .superRefine((options, context) => {
        if (options.all_events && options.event_limit !== undefined)
          context.addIssue({
            code: "custom",
            path: ["all_events"],
            message: "all_events and event_limit are mutually exclusive",
          });
      }),
    run: ({ args, options: { all_events, ...options } }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectProcmonExport, async () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  ...options,
                  ...(all_events ? { event_limit: null } : {}),
                  path: resolve(args.path),
                },
                { signal },
              ),
            service,
            "procmon-export",
            "inspect_procmon_export",
          ),
        ),
      ),
  });
};
