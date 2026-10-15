# Verification (#3766)

Hand-built fixtures in `tests/fixtures/procmon/` (no captured third-party data):
`events.csv` (BOM, CRLF, quoted comma, doubled quotes, embedded newline),
`events.xml` (process list, entities, CDATA, self-closing field, nested stack),
`missing-columns.csv`, `truncated.csv`, `truncated.xml`, `malformed.xml`,
`unrelated.csv`.

- `tests/boundary/captures/procmonExport.test.ts`: CSV/XML projection, missing
  columns, truncation, malformed and unrelated inputs, non-decimal PIDs, paging,
  relative/unknown/missing input, non-UTF-8 bytes, BOM-marked UTF-16LE, cancellation, stable identity
  on a read-only copy.
- `tests/boundary/cli/procmonExportCli.test.ts`: CLI paging and options, malformed
  reporting, `all_events`/`event_limit` exclusivity.
- `tests/boundary/mcp/procmonExportMcp.test.ts`: advertised schemas validate,
  unknown input rejected, structured output validates against the output schema.
- Existing `src/contracts/toolEffects.test.ts`, conformance and composition
  projects pass with the new contract.

Not verified: exports produced by every Procmon release or locale, and exports near the 64 MiB ceiling.
