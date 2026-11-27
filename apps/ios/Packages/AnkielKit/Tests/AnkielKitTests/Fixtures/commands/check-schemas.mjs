// Decodes every command fixture with the server's own Effect schemas, and writes the provider
// catalog fixture by encoding a sample through the real `ServerProvider` / `ServerSettings`
// schemas. Run from the repo's `packages/contracts`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/commands/check-schemas.mjs [--check]
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
  turnDiff: m.OrchestrationGetTurnDiffInput,
  diffPreview: m.ReviewDiffPreviewInput,
  diffFileContents: m.ReviewDiffFileContentsInput,
  vcsRefreshStatus: S.Struct({ ...m.VcsStatusInput.fields, localOnly: S.optional(S.Boolean) }),
  vcsPull: m.VcsPullInput,
  vcsListRefs: m.VcsListRefsInput,
  vcsCreateRef: m.VcsCreateRefInput,
  gitAction: m.GitRunStackedActionInput,
  command: m.OrchestrationV2Command,
  launch: m.OrchestrationV2ThreadLaunchInput,
  uploadUrl: m.AttachmentCreateUploadUrlInput,
  attachmentDelete: m.AttachmentDeleteInput,
  secretAnswer: m.SecretRequestAnswerInput,
  updateSettings: S.Struct({ patch: m.ClientServerSettingsPatch }),
  serverUpdate: m.ServerSelfUpdateInput,
  listEntries: m.ProjectListEntriesInput,
  searchEntries: m.ProjectSearchEntriesInput,
  readFile: m.ProjectReadFileInput,
  assetUrl: m.AssetCreateUrlInput,
  metadata: m.FilesystemGetMetadataInput,
  pushRegister: m.PushRegisterInput,
};

let failures = 0;
for (const name of readdirSync(here).filter((file) => file.endsWith(".json")).sort()) {
  const { schema, value } = JSON.parse(readFileSync(join(here, name), "utf8"));
  // Strict: an unknown key must fail, or a misspelled setting would decode as an empty no-op patch.
  const exit = S.decodeUnknownExit(schemas[schema])(value, { onExcessProperty: "error" });
  if (exit._tag === "Success" && schema === "updateSettings") {
    const roundTrip = JSON.stringify(S.encodeSync(schemas[schema])(exit.value));
    const scopes = m.requiredScopesForServerSettingsPatch(exit.value.patch);
    if (roundTrip !== JSON.stringify(value) && JSON.stringify(JSON.parse(roundTrip)) !== JSON.stringify(value)) {
      failures += 1;
      console.log(`FAIL ${name}: round trip changed it: ${roundTrip}`);
      continue;
    }
    if (scopes.length !== 1 || scopes[0] !== "settings:write") {
      failures += 1;
      console.log(`FAIL ${name}: needs ${scopes.join(", ")}, expected settings:write only`);
      continue;
    }
  }
  if (exit._tag === "Success") {
    console.log(`ok   ${name} (${schema})`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} (${schema}): ${String(exit.cause)}`);
  }
}

// A misspelled key must be refused by the strict decode above.
{
  const exit = S.decodeUnknownExit(schemas.updateSettings)({ patch: { sidebarAutoSettleAfterDay: null } }, { onExcessProperty: "error" });
  if (exit._tag === "Success") {
    failures += 1;
    console.log("FAIL strictness: a misspelled settings key decoded");
  } else {
    console.log("ok   strictness: a misspelled settings key is refused");
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
const catalogPath = join(here, "..", "provider-catalog.json");
const catalog = JSON.stringify({ providers: encodedProviders, settings: encodedSettings }, null, 2) + "\n";
// --check (check:changed) compares instead of writing: a contracts change that alters the encoding
// fails here until the fixture is rewritten and the Swift tests pass against it.
if (process.argv.includes("--check")) {
  if (readFileSync(catalogPath, "utf8") === catalog) {
    console.log("ok   provider-catalog.json matches the schemas");
  } else {
    failures += 1;
    console.log("FAIL provider-catalog.json is stale: run this script without --check, then swift test");
  }
} else {
  writeFileSync(catalogPath, catalog);
  console.log("wrote provider-catalog.json");
}
process.exit(failures === 0 ? 0 : 1);
