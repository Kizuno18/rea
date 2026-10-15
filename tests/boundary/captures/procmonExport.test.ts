import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProcmonExportService } from "../../../src/application/captures/ProcmonExportService.js";
import { ProcmonExportReader } from "../../../src/captures/procmon/ProcmonExportReader.js";
import {
  parseProcmonCsv,
  parseProcmonExport,
  parseProcmonXml,
  ProcmonExportFormatError,
} from "../../../src/captures/procmon/parseProcmonExport.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { procmonExportSchema } from "../../../src/domain/captures/procmonExport.js";

const fixture = (name: string): string =>
  resolve("tests/fixtures/procmon", name);
const service = new ProcmonExportService(new ProcmonExportReader());
const report = (value: unknown) =>
  procmonExportSchema.parse(
    (value as { normalized_result: unknown }).normalized_result,
  );

describe("Procmon CSV exports", () => {
  it("decodes quoted fields, embedded newlines, BOM and CRLF with source lines", async () => {
    const result = await service.inspect({ path: fixture("events.csv") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = report(result.value);
    expect(parsed.format).toBe("csv");
    expect(parsed.columns.missing).toEqual([]);
    expect(parsed.coverage).toEqual({
      parsed_events: 3,
      returned_events: 3,
      has_more: false,
      status: "complete",
    });
    expect(parsed.events[0]).toMatchObject({
      process_name: "sample.exe",
      pid: 4120,
      operation: "CreateFile",
      path: "C:\\Temp\\a, b.txt",
      result: "SUCCESS",
      source: { kind: "csv-line", line: 2 },
    });
    expect(parsed.events[2]).toMatchObject({
      process_name: 'svc "quoted".exe',
      detail: 'Command line: "x.exe"\r\n/flag',
      source: { kind: "csv-line", line: 4 },
    });
    expect(result.value.subject?.digest.sha256).toBe(parsed.artifact.sha256);
    expect(parsed.acquisition).toBe("recorded-export-read-only");
  });

  it("reports missing required columns as unknown null values", async () => {
    const result = await service.inspect({
      path: fixture("missing-columns.csv"),
    });
    if (!result.ok) throw result.error;
    const parsed = report(result.value);
    expect(parsed.columns.missing).toEqual(["pid", "path"]);
    expect(parsed.events[0]).toMatchObject({
      pid: null,
      pid_text: null,
      path: null,
    });
  });

  it("keeps complete rows and marks a truncated trailing row", async () => {
    const result = await service.inspect({ path: fixture("truncated.csv") });
    if (!result.ok) throw result.error;
    const parsed = report(result.value);
    expect(parsed.coverage.status).toBe("truncated");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.issues[0]).toMatch(/quoted CSV field/);
  });

  it("marks an unterminated quote as truncation", () => {
    const parsed = parseProcmonCsv('"PID","Operation"\n"1","Read\n');
    expect(parsed.status).toBe("truncated");
    expect(parsed.events).toEqual([]);
  });

  it("rejects mid-file column-count mismatches, stray quotes and unrelated CSV", async () => {
    expect(() => parseProcmonCsv('"PID","Path"\n"1"\n"2","x"\n')).toThrow(
      ProcmonExportFormatError,
    );
    expect(() => parseProcmonCsv('PID,Path\n1,a"b\n')).toThrow(/quote/);
    expect(() => parseProcmonCsv('"PID","pid"\n1,2\n')).toThrow(
      /more than one/,
    );
    expect(() => parseProcmonCsv("")).toThrow(/header/);
    const result = await service.inspect({ path: fixture("unrelated.csv") });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  });

  it("keeps non-numeric PIDs verbatim", () => {
    const parsed = parseProcmonCsv('"PID"\n"<unknown>"\n');
    expect(parsed.events[0]).toMatchObject({
      pid: null,
      pid_text: "<unknown>",
    });
  });
});

describe("Procmon XML exports", () => {
  it("projects event children, entities, CDATA and skips nested stacks", async () => {
    const result = await service.inspect({ path: fixture("events.xml") });
    if (!result.ok) throw result.error;
    const parsed = report(result.value);
    expect(parsed.format).toBe("xml");
    expect(parsed.coverage.status).toBe("complete");
    expect(parsed.columns.missing).toEqual([]);
    expect(parsed.columns.unmapped).toEqual(["ProcessIndex", "stack"]);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({
      time_of_day: "4:51:23.1234567 PM",
      pid: 4120,
      path: "C:\\Temp\\a & b.txt",
      source: { kind: "xml-event", ordinal: 1 },
    });
    expect(parsed.events[1]).toMatchObject({
      path: "HKLM\\Software\\<Example>",
      detail: "",
    });
  });

  it("keeps complete events from a truncated export", async () => {
    const result = await service.inspect({ path: fixture("truncated.xml") });
    if (!result.ok) throw result.error;
    const parsed = report(result.value);
    expect(parsed.coverage.status).toBe("truncated");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.pid).toBe(7);
  });

  it("rejects mismatched tags, wrong roots, undeclared entities and trailing content", async () => {
    const result = await service.inspect({ path: fixture("malformed.xml") });
    expect(result.ok).toBe(false);
    expect(() => parseProcmonXml("<other/>")).toThrow(/root/);
    expect(() =>
      parseProcmonXml(
        "<procmon><eventlist><event><Path>&bogus;</Path></event></eventlist></procmon>",
      ),
    ).toThrow(/entity/);
    expect(() => parseProcmonXml("<procmon></procmon><x/>")).toThrow(/after/);
    expect(() => parseProcmonXml("")).toThrow(/root/);
  });

  it("reports an export without an eventlist", () => {
    const parsed = parseProcmonXml("<procmon><processlist/></procmon>");
    expect(parsed.events).toEqual([]);
    expect(parsed.columns.missing).toHaveLength(6);
    expect(parsed.issues).toContain("XML export has no <eventlist> element.");
  });

  it("honours an explicit format over detection", () => {
    expect(() => parseProcmonExport('"PID"\n"1"\n', "xml")).toThrow(
      ProcmonExportFormatError,
    );
  });
});

describe("Procmon export service", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-procmon-"));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  it("pages events and reports has_more", async () => {
    const result = await service.inspect({
      path: fixture("events.csv"),
      event_offset: 1,
      event_limit: 1,
    });
    if (!result.ok) throw result.error;
    const parsed = report(result.value);
    expect(parsed.events.map((event) => event.index)).toEqual([1]);
    expect(parsed.coverage).toMatchObject({
      returned_events: 1,
      has_more: true,
    });
  });

  it("rejects relative paths, unknown options and missing files", async () => {
    expect((await service.inspect({ path: "events.csv" })).ok).toBe(false);
    expect(
      (await service.inspect({ path: fixture("events.csv"), launch: true })).ok,
    ).toBe(false);
    const missing = await service.inspect({
      path: join(directory, "none.csv"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBeInstanceOf(AnalysisInputError);
  });

  it("decodes BOM-marked UTF-16LE exports", async () => {
    const path = join(directory, "utf16.csv");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"PID","Operation"\r\n"9","ReadFile"\r\n', "utf16le"),
      ]),
    );
    const result = await service.inspect({ path });
    if (!result.ok) throw result.error;
    expect(report(result.value).events[0]).toMatchObject({
      pid: 9,
      operation: "ReadFile",
    });
  });

  it("rejects non-UTF-8 bytes and honours cancellation", async () => {
    const path = join(directory, "binary.csv");
    await writeFile(path, Buffer.from([0x50, 0x4d, 0x4c, 0xc3, 0x28]));
    const binary = await service.inspect({ path });
    expect(binary.ok).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await service.inspect(
      { path: fixture("events.csv") },
      { signal: controller.signal },
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok)
      expect(cancelled.error).toBeInstanceOf(AnalysisCancelledError);
  });

  it("does not modify the selected export", async () => {
    const path = join(directory, "copy.csv");
    await copyFile(fixture("events.csv"), path);
    await chmod(path, 0o400);
    const first = await service.inspect({ path });
    const second = await service.inspect({ path });
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(report(first.value).artifact).toEqual(report(second.value).artifact);
  });
});
