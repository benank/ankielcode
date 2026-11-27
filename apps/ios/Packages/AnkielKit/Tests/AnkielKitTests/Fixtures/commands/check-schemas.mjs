// Decodes every command fixture with the server's own Effect schemas, and writes the provider
// catalog fixture by encoding a sample through the real `ServerProvider` / `ServerSettings`
// schemas. Run from the repo's `packages/contracts`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = pathToFileURL(join(process.cwd(), "src/index.ts")).href;
const m = await import(contracts);
const S = await import(pathToFileURL(join(process.cwd(), "node_modules/effect/dist/Schema.js")).href).catch(
  () => import("effect/Schema"),
);

const schemas = {
  command: m.OrchestrationV2Command,
  launch: m.OrchestrationV2ThreadLaunchInput,
  uploadUrl: m.AttachmentCreateUploadUrlInput,
  attachmentDelete: m.AttachmentDeleteInput,
  secretAnswer: m.SecretRequestAnswerInput,
};

let failures = 0;
for (const name of readdirSync(here).filter((file) => file.endsWith(".json")).sort()) {
  const { schema, value } = JSON.parse(readFileSync(join(here, name), "utf8"));
  const exit = S.decodeUnknownExit(schemas[schema])(value);
  if (exit._tag === "Success") {
    console.log(`ok   ${name} (${schema})`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} (${schema}): ${String(exit.cause)}`);
  }
}

// The catalog sample: two instances, effort select + fast boolean, a hidden model.
const provider = (instanceId, driver, displayName, models, extra = {}) => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-27T09:00:00.000Z",
  models,
  ...extra,
});
const effort = {
  type: "select",
  id: "effort",
  label: "Effort",
  role: "reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra high" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};
const fast = { type: "boolean", id: "fastMode", label: "Fast mode" };
const sample = {
  providers: [
    provider("claudeAgent", "claudeAgent", "Claude", [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5", isCustom: false, isDefault: true, capabilities: { optionDescriptors: [effort, fast] } },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5", isCustom: false, capabilities: { optionDescriptors: [effort] } },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", shortName: "Haiku 5.5", isCustom: false, capabilities: null },
      { slug: "claude-legacy", name: "Claude Legacy", isCustom: false, isLegacy: true, capabilities: null },
    ], { continuation: { groupKey: "claude" }, supportedRuntimeModes: ["approval-required", "auto", "full-access"] }),
    provider("devReplay", "devReplay", "Replay (dev)", [
      { slug: "replay", name: "Replay", isCustom: false, capabilities: null },
    ]),
    provider("codex", "codex", undefined, [
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
    ], { auth: { status: "unauthenticated" } }),
  ],
  settings: {
    defaultRuntimeMode: "auto",
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    providerModelPreferences: { claudeAgent: { hiddenModels: ["claude-haiku-5-5"], modelOrder: [] } },
  },
};
const encodedProviders = sample.providers.map((value) =>
  S.encodeSync(m.ServerProvider)(S.decodeUnknownSync(m.ServerProvider)(value)),
);
const encodedSettings = S.encodeSync(m.ServerSettings)(S.decodeUnknownSync(m.ServerSettings)(sample.settings));
writeFileSync(
  join(here, "..", "provider-catalog.json"),
  JSON.stringify({ providers: encodedProviders, settings: encodedSettings }, null, 2) + "\n",
);
console.log("wrote provider-catalog.json");
process.exit(failures === 0 ? 0 : 1);
