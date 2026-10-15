import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";

it("advertises valid schemas and returns Evidence for a recorded CSV export", async () => {
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  const tool = (await harness.client.listTools()).tools.find(
    (candidate) => candidate.name === "inspect_procmon_export",
  );
  if (tool?.outputSchema === undefined)
    throw new Error("Procmon export tool missing");
  expect(tool.annotations).toMatchObject({ readOnlyHint: false });
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = tool.inputSchema;
  const outputSchema: Record<string, unknown> = tool.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const path = resolve("tests/fixtures/procmon/events.csv");
  expect(ajv.validate(inputSchema, { path, launch: true })).toBe(false);
  const result = await harness.client.callTool({
    name: tool.name,
    arguments: { path, event_limit: 2 },
  });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.structuredContent)).toContain("RegOpenKey");
  expect(ajv.validate(outputSchema, result.structuredContent)).toBe(true);
});
