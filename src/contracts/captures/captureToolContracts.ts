import {
  inspectPacketFieldsInputSchema,
  packetFieldsCatalogSchema,
} from "../../domain/captures/packetFields.js";
import {
  inspectPacketCaptureInputSchema,
  packetCaptureSchema,
} from "../../domain/captures/packetCapture.js";
import {
  inspectProcmonExportInputSchema,
  procmonExportSchema,
} from "../../domain/captures/procmonExport.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const CAPTURE_TOOL_CONTRACTS = [
  {
    name: "inspect_packet_fields",
    ...toolContractMetadata("inspect_packet_fields"),
    kind: "artifact-provider",
    description:
      "Discover protocols or field names/types registered in the installed TShark 4.x. kind defaults to protocols; use fields and optional exact protocol abbreviation to select field definitions. query searches name/abbreviation/description by case-insensitive literal substring. Return 50 matches by default with offset/limit paging; null requests all remaining within resource limits. Preserve type/base/bitmask/description, duplicate registrations, source line numbers, coverage, tool identity and diagnostics. Linux, REA_TSHARK_COMMAND and prlimit required. No capture file, interface or binary target needed. Registrations describe tool capabilities, not observed traffic. Each call rereads the glossary; use selected fields with inspect_packet_capture.",
    inputSchema: inspectPacketFieldsInputSchema,
    outputSchema: evidenceResultOf(packetFieldsCatalogSchema),
    examples: [
      { title: "Find USB protocol registrations", input: { query: "usb" } },
      {
        title: "Find the installed USB vendor-ID field",
        input: { kind: "fields", protocol: "usb", query: "idVendor" },
      },
    ],
  },
  {
    name: "inspect_packet_capture",
    ...toolContractMetadata("inspect_packet_capture"),
    kind: "artifact-provider",
    description:
      "Inspect caller-selected fields in an existing local packet capture with TShark 4.x. Return 50 matching frames by default, with match_offset/match_limit paging and coverage counts; match_limit:null requests all remaining matches. Preserve repeated values, frame numbers, display filter, decode-as rules and pass mode in inline Evidence with source/tool identity and diagnostics. Optional packet_limit counts input packets before filtering; output paging does not shorten dissection or two-pass reassembly. Requires Linux, util-linux prlimit, and absolute REA_TSHARK_COMMAND. File-only analysis; no live capture or device communication. Missing fields or no matches do not establish absence of device traffic.",
    inputSchema: inspectPacketCaptureInputSchema,
    outputSchema: evidenceResultOf(packetCaptureSchema),
    examples: [
      {
        title: "Inspect UDP exchanges in a recording",
        input: {
          path: "/artifacts/device.pcapng",
          fields: ["ip.addr", "udp.port", "data.data"],
          display_filter: "udp",
          decode_as: [],
          packet_limit: null,
          two_pass: true,
        },
      },
    ],
  },
  {
    name: "inspect_procmon_export",
    ...toolContractMetadata("inspect_procmon_export"),
    kind: "artifact-provider",
    description:
      "Read an existing Process Monitor export saved as XML or CSV (export_format auto|xml|csv) and return recorded events: Time of Day, Process Name, PID, Operation, Path, Result and Detail, each with its CSV line or XML event ordinal. Returns 200 events by default with event_offset/event_limit paging; event_limit:null returns all remaining. Columns absent from the export are listed in columns.missing and their values are null (unknown). Preserves export path, SHA-256 and byte length; truncated exports report coverage.status truncated with the complete events parsed so far. File-only: reads the selected export; Procmon, drivers, live tracing and PML decoding are not used. Recorded events reflect the exporter's filters, not complete system activity.",
    inputSchema: inspectProcmonExportInputSchema,
    outputSchema: evidenceResultOf(procmonExportSchema),
    examples: [
      {
        title: "Read the first page of a CSV export",
        input: { path: "/artifacts/logfile.csv" },
      },
      {
        title: "Read every event from an XML export",
        input: {
          path: "/artifacts/logfile.xml",
          export_format: "xml",
          event_offset: 0,
          event_limit: null,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
