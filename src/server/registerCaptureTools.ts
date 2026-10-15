import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ProcmonExportService } from "../application/captures/ProcmonExportService.js";
import type { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the named capture contract through shared admission and retained Evidence delivery. */
export const registerCaptureTools = (
  server: EvidenceMcpServer,
  service: PacketCaptureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  procmonExport?: ProcmonExportService,
): void => {
  const contract = toolContract("inspect_packet_capture");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
  const discovery = toolContract("inspect_packet_fields");
  const discover = createEvidenceToolHandler(
    server,
    (input, options) => service.inspectFields(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    discovery.name,
    toolRegistrationOptions(discovery),
    discover(discovery),
  );
  if (procmonExport === undefined) return;
  const procmon = toolContract("inspect_procmon_export");
  const inspectProcmon = createEvidenceToolHandler(
    server,
    (input, options) => procmonExport.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    procmon.name,
    toolRegistrationOptions(procmon),
    inspectProcmon(procmon),
  );
};
