import { Cli } from "incur";
import { expect, it } from "vitest";

import { registerProcmonCommands } from "../../../src/cli/procmonCommands.js";
import { silentLogger } from "../../../src/logger.js";

const run = async (args: string[]): Promise<unknown> => {
  const cli = Cli.create("procmon-export-test", { sync: false });
  registerProcmonCommands(cli, silentLogger);
  let stdout = "";
  await cli.serve([...args, "--format", "json"], {
    stdout: (text) => {
      stdout += text;
    },
    exit: () => {},
  });
  return JSON.parse(stdout);
};

it("reads an XML export through the shared Evidence service", async () => {
  const output = await run([
    "inspect-procmon-export",
    "tests/fixtures/procmon/events.xml",
    "--export_format",
    "xml",
    "--event_limit",
    "1",
  ]);
  expect(output).toMatchObject({
    operation: "inspect_procmon_export",
    normalized_result: {
      format: "xml",
      coverage: { parsed_events: 2, returned_events: 1, has_more: true },
      events: [{ operation: "CreateFile", pid: 4120 }],
    },
  });
});

it("reports malformed exports as unsupported targets", async () => {
  const output = await run([
    "inspect-procmon-export",
    "tests/fixtures/procmon/malformed.xml",
  ]);
  expect(JSON.stringify(output)).toMatch(/Mismatched XML close tag/);
});

it("rejects combining all_events with event_limit", async () => {
  const output = await run([
    "inspect-procmon-export",
    "tests/fixtures/procmon/events.csv",
    "--all_events",
    "--event_limit",
    "1",
  ]);
  expect(JSON.stringify(output)).toMatch(/mutually exclusive/);
});
