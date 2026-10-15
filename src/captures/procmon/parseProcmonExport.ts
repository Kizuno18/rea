import {
  PROCMON_REQUIRED_FIELDS,
  type ProcmonEvent,
  type ProcmonExportField,
} from "../../domain/captures/procmonExport.js";

/** The export bytes do not form the documented Procmon XML or CSV subset. */
export class ProcmonExportFormatError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProcmonExportFormatError";
  }
}

export interface ParsedProcmonExport {
  readonly format: "xml" | "csv";
  readonly columns: {
    readonly source: readonly string[];
    readonly mapped: readonly ProcmonExportField[];
    readonly missing: readonly ProcmonExportField[];
    readonly unmapped: readonly string[];
  };
  readonly events: readonly ProcmonEvent[];
  readonly status: "complete" | "truncated";
  readonly issues: readonly string[];
}

const FIELD_ALIASES: Readonly<Record<string, ProcmonExportField>> = {
  timeofday: "time_of_day",
  time: "time_of_day",
  processname: "process_name",
  pid: "pid",
  operation: "operation",
  path: "path",
  result: "result",
  detail: "detail",
};

/** Map a CSV header ("Process Name") or XML element ("Process_Name") to a field. */
export const procmonFieldOf = (name: string): ProcmonExportField | undefined =>
  FIELD_ALIASES[name.toLowerCase().replace(/[^a-z0-9]/g, "")];

/** Decode export bytes; UTF-8 (optional BOM) or BOM-marked UTF-16LE only. */
export const decodeProcmonExport = (bytes: Uint8Array): string => {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(
        bytes.subarray(2),
      );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new ProcmonExportFormatError(
      "Export is not valid UTF-8 or BOM-marked UTF-16LE text.",
    );
  }
};

/** Detect XML by its first non-space character; everything else is CSV. */
export const detectProcmonFormat = (text: string): "xml" | "csv" =>
  text
    .replace(/^\uFEFF/, "")
    .trimStart()
    .startsWith("<")
    ? "xml"
    : "csv";

type Values = Partial<Record<ProcmonExportField, string>>;

const projectEvent = (
  index: number,
  values: Values,
  source: ProcmonEvent["source"],
): ProcmonEvent => {
  const pidText = values.pid ?? null;
  const pid =
    pidText !== null && /^[0-9]+$/.test(pidText.trim())
      ? Number(pidText.trim())
      : null;
  return {
    index,
    time_of_day: values.time_of_day ?? null,
    process_name: values.process_name ?? null,
    pid: pid !== null && Number.isSafeInteger(pid) ? pid : null,
    pid_text: pidText,
    operation: values.operation ?? null,
    path: values.path ?? null,
    result: values.result ?? null,
    detail: values.detail ?? null,
    source,
  };
};

const columnsOf = (source: readonly string[]) => {
  const mapped: ProcmonExportField[] = [];
  const unmapped: string[] = [];
  for (const name of source) {
    const field = procmonFieldOf(name);
    if (field === undefined) unmapped.push(name);
    else if (!mapped.includes(field)) mapped.push(field);
  }
  return {
    source: [...source],
    mapped,
    missing: PROCMON_REQUIRED_FIELDS.filter((field) => !mapped.includes(field)),
    unmapped,
  };
};

interface CsvRecord {
  readonly fields: string[];
  readonly line: number;
  readonly terminated: boolean;
}

/** RFC 4180 records with physical start lines; an open quote at EOF is unterminated. */
const csvRecords = (
  text: string,
): { records: CsvRecord[]; openQuote: boolean } => {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (c === '"')
      throw new ProcmonExportFormatError(
        `CSV line ${String(line)}: quote inside an unquoted field.`,
      );
    else if (c === ",") {
      fields.push(field);
      field = "";
      fieldStarted = false;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      fields.push(field);
      if (!(fields.length === 1 && fields[0] === ""))
        records.push({ fields, line: start, terminated: true });
      fields = [];
      field = "";
      fieldStarted = false;
      line++;
      start = line;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) return { records, openQuote: true };
  if (fieldStarted || fields.length > 0) {
    fields.push(field);
    records.push({ fields, line: start, terminated: false });
  }
  return { records, openQuote: false };
};

export const parseProcmonCsv = (input: string): ParsedProcmonExport => {
  const text = input.replace(/^\uFEFF/, "");
  const { records, openQuote } = csvRecords(text);
  const issues: string[] = [];
  const header = records.shift();
  if (header === undefined)
    throw new ProcmonExportFormatError("CSV export has no header row.");
  const columns = columnsOf(header.fields);
  const seen = new Set<ProcmonExportField>();
  for (const name of header.fields) {
    const field = procmonFieldOf(name);
    if (field === undefined) continue;
    if (seen.has(field))
      throw new ProcmonExportFormatError(
        `CSV header maps more than one column to ${field}.`,
      );
    seen.add(field);
  }
  if (columns.mapped.length === 0)
    throw new ProcmonExportFormatError(
      "CSV header has no recognised Procmon columns.",
    );
  let status: "complete" | "truncated" = openQuote ? "truncated" : "complete";
  if (openQuote)
    issues.push(
      "Export ends inside a quoted CSV field; that record was dropped.",
    );
  const events: ProcmonEvent[] = [];
  records.forEach((record, position) => {
    if (record.fields.length !== header.fields.length) {
      const last = position === records.length - 1;
      if (
        last &&
        !record.terminated &&
        record.fields.length < header.fields.length
      ) {
        status = "truncated";
        issues.push(
          `CSV line ${String(record.line)} ends before all columns; that record was dropped.`,
        );
        return;
      }
      throw new ProcmonExportFormatError(
        `CSV line ${String(record.line)} has ${String(record.fields.length)} fields; header has ${String(header.fields.length)}.`,
      );
    }
    const values: Values = {};
    header.fields.forEach((name, column) => {
      const field = procmonFieldOf(name);
      if (field !== undefined) values[field] = record.fields[column] ?? "";
    });
    events.push(
      projectEvent(events.length, values, {
        kind: "csv-line",
        line: record.line,
      }),
    );
  });
  return { format: "csv", columns, events, status, issues };
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXmlText = (value: string): string =>
  value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);|&/g,
    (match, body?: string) => {
      if (body === undefined)
        throw new ProcmonExportFormatError("Unescaped '&' in XML text.");
      if (body.startsWith("#")) {
        const code = body.startsWith("#x")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff)
          throw new ProcmonExportFormatError(
            `Invalid XML character reference ${match}.`,
          );
        return String.fromCodePoint(code);
      }
      const named = ENTITIES[body];
      if (named === undefined)
        throw new ProcmonExportFormatError(`Undeclared XML entity ${match}.`);
      return named;
    },
  );

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gy;

/**
 * Parse the documented Procmon XML export subset:
 * `<procmon>…<eventlist><event><Process_Name>…</Process_Name>…</event></eventlist></procmon>`.
 * Only direct `event` children with text content become fields; nested
 * children (for example stacks) are skipped and their element names reported.
 */
export const parseProcmonXml = (input: string): ParsedProcmonExport => {
  const text = input.replace(/^\uFEFF/, "");
  const issues: string[] = [];
  const stack: string[] = [];
  const source: string[] = [];
  const events: ProcmonEvent[] = [];
  let sawRoot = false;
  let sawEventList = false;
  let eventListClosed = false;
  let current: Values | undefined;
  let child: { name: string; text: string; nested: boolean } | undefined;
  let ordinal = 0;
  let position = 0;
  const truncated = (): ParsedProcmonExport => {
    issues.push(
      current === undefined
        ? "Export ends before the XML document is closed."
        : "Export ends inside an <event>; that event was dropped.",
    );
    return finish("truncated");
  };
  const finish = (status: "complete" | "truncated"): ParsedProcmonExport => {
    if (!sawEventList) issues.push("XML export has no <eventlist> element.");
    return {
      format: "xml",
      columns: columnsOf(source),
      events,
      status,
      issues,
    };
  };
  while (position < text.length) {
    const lt = text.indexOf("<", position);
    const chunk = text.slice(position, lt === -1 ? text.length : lt);
    if (chunk.length > 0) {
      if (child !== undefined && !child.nested && stack.length === 4)
        child.text += decodeXmlText(chunk);
      else if (chunk.trim().length > 0 && stack.length < 3)
        throw new ProcmonExportFormatError(
          "Unexpected text outside Procmon XML elements.",
        );
    }
    if (lt === -1) break;
    TOKEN.lastIndex = lt;
    const token = TOKEN.exec(text);
    if (token === null) {
      if (text.indexOf(">", lt) === -1) return truncated();
      throw new ProcmonExportFormatError(
        `Malformed XML markup at offset ${String(lt)}.`,
      );
    }
    position = TOKEN.lastIndex;
    const [raw, cdata, closing, name, , selfClosing] = token;
    if (cdata !== undefined) {
      if (child !== undefined && !child.nested && stack.length === 4)
        child.text += cdata;
      continue;
    }
    if (name === undefined) continue;
    if (!sawRoot) {
      if (name !== "procmon" || closing === "/")
        throw new ProcmonExportFormatError(
          `XML root must be <procmon>, found ${raw}.`,
        );
      sawRoot = true;
    }
    if (closing === "/") {
      const open = stack.pop();
      if (open !== name)
        throw new ProcmonExportFormatError(
          `Mismatched XML close tag </${name}>; expected </${open ?? "nothing"}>.`,
        );
      if (stack.length === 3 && child !== undefined) {
        const field = procmonFieldOf(child.name);
        if (field !== undefined && current !== undefined && !child.nested)
          current[field] = child.text;
        child = undefined;
      } else if (
        stack.length === 2 &&
        name === "event" &&
        current !== undefined
      ) {
        events.push(
          projectEvent(events.length, current, { kind: "xml-event", ordinal }),
        );
        current = undefined;
      } else if (stack.length === 1 && name === "eventlist")
        eventListClosed = true;
      else if (stack.length === 0) {
        if (
          text
            .slice(position)
            .replace(/<!--[\s\S]*?-->/g, "")
            .trim() !== ""
        )
          throw new ProcmonExportFormatError("Content after </procmon>.");
        if (sawEventList && !eventListClosed) return truncated();
        return finish("complete");
      }
      continue;
    }
    const depth = stack.length;
    if (depth === 1 && name === "eventlist") sawEventList = true;
    if (depth === 2 && stack[1] === "eventlist" && name === "event") {
      ordinal++;
      if (selfClosing !== "/") current = {};
      else
        events.push(
          projectEvent(events.length, {}, { kind: "xml-event", ordinal }),
        );
    } else if (depth === 3 && current !== undefined) {
      if (!source.includes(name)) source.push(name);
      if (selfClosing === "/") {
        const field = procmonFieldOf(name);
        if (field !== undefined) current[field] = "";
      } else child = { name, text: "", nested: false };
    } else if (depth >= 4 && child !== undefined) child.nested = true;
    if (selfClosing !== "/") stack.push(name);
  }
  if (!sawRoot)
    throw new ProcmonExportFormatError("XML export has no <procmon> root.");
  return truncated();
};

/** Parse caller-selected export text under the requested or detected format. */
export const parseProcmonExport = (
  text: string,
  format: "auto" | "xml" | "csv",
): ParsedProcmonExport => {
  const selected = format === "auto" ? detectProcmonFormat(text) : format;
  return selected === "xml" ? parseProcmonXml(text) : parseProcmonCsv(text);
};
