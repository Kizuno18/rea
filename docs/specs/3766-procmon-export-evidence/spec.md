# Offline Procmon export evidence (#3766)

## Outcome and scope

`inspect_procmon_export` (CLI `inspect-procmon-export`) reads one existing,
caller-supplied Process Monitor export saved as XML or CSV and returns its
recorded events as capture Evidence. It answers "what did this recorded export
contain?", not "what did the process do?". Scope is a recorded capture:
execution authority is N/A. Live ETW collection for a selected process is the
separate, complementary #2689 (live versus offline).

Non-goals: launching Procmon or any other process, loading drivers, live
tracing, decoding the proprietary PML log format, bundling Procmon binaries, and
behavioural interpretation of events.

## Input

Strict object: absolute `path`; `export_format: auto | xml | csv` (default
`auto`, which selects XML when the first non-space character is `<`);
`event_offset` (default 0); `event_limit` (default 200, `null` = all remaining).
Unknown keys are rejected. The CLI exposes `--all_events` for `null`.

## Supported formats

Text must be UTF-8 (optional BOM) or BOM-marked UTF-16LE; anything else is an
unsupported target.

- **CSV** (File → Save → CSV): RFC 4180 records with a header row. Quoted fields
  may contain commas, doubled quotes and line breaks. Headers map
  case/punctuation-insensitively: `Time of Day`/`Time`, `Process Name`, `PID`,
  `Operation`, `Path`, `Result`, `Detail`. Other headers are kept in
  `columns.unmapped`. Two headers mapping to one field, a stray quote in an
  unquoted field, a header with no recognised column, or a non-final row with
  the wrong field count are malformed.
- **XML** (File → Save → XML): `<procmon>` root, `<eventlist>` of `<event>`
  elements whose direct text children (`Time_of_Day`, `Process_Name`, `PID`,
  `Operation`, `Path`, `Result`, `Detail`) become fields. The five predefined
  entities, numeric character references and CDATA are decoded. Nested children
  such as stacks are skipped and their element names reported as unmapped;
  `<processlist>` is not decoded. Mismatched tags, wrong roots, undeclared
  entities and content after `</procmon>` are malformed.

## Result

- `artifact`: path, SHA-256 and byte length of the exact bytes parsed; the
  Evidence subject carries the same digest.
- `format`, `columns` (`source` order, `mapped`, `missing`, `unmapped`).
- `events[]`: `index`, the seven fields, `pid` as an integer when the text is
  decimal (otherwise `null` with `pid_text` kept verbatim), and `source` (CSV
  physical start line or XML event ordinal).
- `coverage`: `parsed_events`, `returned_events`, `has_more`, `status`.
- `issues[]`, `acquisition: "recorded-export-read-only"`.

## Unknowns, truncation and failure

A required column absent from the export is listed in `columns.missing` and its
values are `null`: unknown, not empty or absent activity. An export ending inside
a quoted field, a short final CSV row, or an unclosed XML event/document yields
`status: "truncated"` with every complete event before it and an issue naming
what was dropped. Malformed structure is an `AnalysisUnsupportedTargetError`;
a missing or unreadable path is an input or access-denied error; a file that
changes while being read is an artifact-changed error.

## Authority and resources

Effects: reads the selected file only, records Evidence in the session. No
process launch, filesystem write, network or device access. Exports above
64 MiB are refused before allocation (resource constraint); accepted exports
are read once into memory, verified unchanged against descriptor and path
metadata, hashed, decoded and parsed in linear passes.

## Limitations

Events reflect Procmon filters and column choices made by whoever exported the
file; REA cannot verify completeness. `Time of Day` is verbatim and carries no
date or zone. The XML reader implements the documented export subset, not a
general XML parser (no DTDs or custom entities).
