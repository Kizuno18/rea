import { z } from "zod";

import { localPathStringSchema } from "../localPath.js";

/** Canonical Procmon export columns projected into capture Evidence. */
export const PROCMON_EXPORT_FIELDS = [
  "time_of_day",
  "process_name",
  "pid",
  "operation",
  "path",
  "result",
  "detail",
] as const;
export type ProcmonExportField = (typeof PROCMON_EXPORT_FIELDS)[number];

/** Required analyst columns; `detail` is optional and never reported missing. */
export const PROCMON_REQUIRED_FIELDS = [
  "time_of_day",
  "process_name",
  "pid",
  "operation",
  "path",
  "result",
] as const satisfies readonly ProcmonExportField[];

export const PROCMON_DEFAULT_EVENT_LIMIT = 200;

export const inspectProcmonExportInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute local path to an existing Procmon XML or CSV export",
  ),
  export_format: z
    .enum(["auto", "xml", "csv"])
    .default("auto")
    .describe("Export format; auto detects XML by a leading '<'"),
  event_offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Parsed events to skip before returning"),
  event_limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(PROCMON_DEFAULT_EVENT_LIMIT)
    .describe("Events to return; null returns all remaining"),
});
export type InspectProcmonExportInput = z.infer<
  typeof inspectProcmonExportInputSchema
>;

const nullableText = z.string().nullable();
export const procmonEventSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  time_of_day: nullableText,
  process_name: nullableText,
  pid: z.number().int().nonnegative().nullable(),
  pid_text: nullableText,
  operation: nullableText,
  path: nullableText,
  result: nullableText,
  detail: nullableText,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("csv-line"), line: z.number().int() }),
    z.strictObject({ kind: z.literal("xml-event"), ordinal: z.number().int() }),
  ]),
});
export type ProcmonEvent = z.infer<typeof procmonEventSchema>;

export const procmonExportSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
    }),
    selection: inspectProcmonExportInputSchema,
    format: z.enum(["xml", "csv"]),
    columns: z.strictObject({
      source: z
        .array(z.string())
        .describe("Original header names or XML element names, in order"),
      mapped: z.array(z.enum(PROCMON_EXPORT_FIELDS)),
      missing: z
        .array(z.enum(PROCMON_EXPORT_FIELDS))
        .describe("Required columns absent from the export: values unknown"),
      unmapped: z.array(z.string()),
    }),
    events: z.array(procmonEventSchema),
    coverage: z.strictObject({
      parsed_events: z.number().int().nonnegative(),
      returned_events: z.number().int().nonnegative(),
      has_more: z.boolean(),
      status: z
        .enum(["complete", "truncated"])
        .describe(
          "truncated: the export ended inside a record; trailing data was not parsed",
        ),
    }),
    issues: z.array(z.string()),
    acquisition: z.literal("recorded-export-read-only"),
  })
  .superRefine((report, context) => {
    const remaining = Math.max(
      report.coverage.parsed_events - report.selection.event_offset,
      0,
    );
    const expected =
      report.selection.event_limit === null
        ? remaining
        : Math.min(remaining, report.selection.event_limit);
    if (
      report.events.length !== expected ||
      report.coverage.returned_events !== expected ||
      report.coverage.has_more !== remaining > expected
    )
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Returned event window must match parsed events and paging",
      });
  });
export type ProcmonExportReport = z.infer<typeof procmonExportSchema>;
