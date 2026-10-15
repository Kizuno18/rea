import { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import { ProcmonExportService } from "../application/captures/ProcmonExportService.js";
import { ProcmonExportReader } from "../captures/procmon/ProcmonExportReader.js";
import { TsharkCaptureProvider } from "../captures/TsharkCaptureProvider.js";
export const createPacketCaptureService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): PacketCaptureService =>
  new PacketCaptureService(new TsharkCaptureProvider(environment));
export const createProcmonExportService = (): ProcmonExportService =>
  new ProcmonExportService(new ProcmonExportReader());
