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
  archivedSnapshot: S.Struct({}),
  refreshProviders: m.WsServerRefreshProvidersRpc.payloadSchema,
  consumeResetCredit: m.ProviderConsumeResetCreditInput,
  terminalAttach: m.TerminalAttachInput,
  terminalOpen: m.TerminalOpenInput,
  terminalWrite: m.TerminalWriteInput,
  terminalResize: m.TerminalResizeInput,
  terminalClear: m.TerminalClearInput,
  terminalClose: m.TerminalCloseInput,
  terminalMetadata: S.Struct({}),
  issuesList: m.IssueListInput,
  issueRef: m.IssueRef,
  issueComments: m.IssueCommentsPageInput,
  previewList: m.PreviewListInput,
  prList: m.PullRequestListInput,
  prListStats: m.PullRequestListStatsInput,
  prRef: m.PullRequestRef,
  prInvalidate: m.PullRequestInvalidateInput,
  prDiff: m.PullRequestDiffInput,
  prReviewerCandidates: m.PullRequestReviewerCandidatesInput,
  prRoutingIdentity: m.PullRequestRoutingIdentityInput,
  prComment: m.PullRequestCommentInput,
  prReply: m.PullRequestThreadReplyInput,
  prReaction: m.PullRequestReactionInput,
  prReview: m.PullRequestSubmitReviewInput,
  prAction: m.PullRequestActionInput,
  prReviewers: m.PullRequestReviewerRequestInput,
  prUpdate: m.PullRequestUpdateInput,
  prResolve: m.PullRequestThreadResolutionInput,
  prFilesViewed: m.PullRequestSetFilesViewedInput,
  accessCreateLink: m.AuthCreatePairingCredentialInput,
  accessRevokeLink: m.AuthRevokePairingLinkInput,
  accessRevokeClient: m.AuthRevokeClientSessionInput,
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
    ], {
      continuation: { groupKey: "claude" },
      supportedRuntimeModes: ["approval-required", "auto", "full-access"],
      // Limits as the usage screens read them (synthetic account).
      auth: { status: "authenticated", label: "Claude Max Subscription", email: "tide@example.com", workspaceId: "ws-tide" },
      usageLimits: {
        checkedAt: "2026-11-27T09:00:00.000Z",
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 35, resetsAt: "2026-11-27T11:00:00.000Z", windowDurationMins: 300 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 52.5, resetsAt: "2026-12-01T00:00:00.000Z", windowDurationMins: 10080 },
        ],
        resetCredits: { availableCount: 2, nextExpiresAt: "2026-12-03T00:00:00.000Z" },
        externalUsage: { label: "Claude usage and resets", url: "https://claude.ai/settings/usage" },
      },
    }),
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
// Sharing & access: a stream as the server encodes it (`AuthAccessStreamEvent`), for the Swift
// reducer. Synthetic devices; written or compared like the catalog.
{
  const scopes = ["orchestration:read", "orchestration:operate", "settings:write", "access:read", "access:write"];
  const phone = {
    sessionId: "session-phone", subject: "pairing-link", ...m.authScopeResponse(scopes), method: "dpop-access-token",
    client: { label: "Tide iPhone", deviceType: "mobile", os: "iOS", ipAddress: "192.168.1.31" },
    issuedAt: "2026-11-24T09:00:00.000Z", expiresAt: "2026-12-24T09:00:00.000Z", lastConnectedAt: "2026-11-27T08:59:00.000Z",
    connected: true, current: true,
  };
  const tablet = {
    sessionId: "session-tablet", subject: "pairing-link", ...m.authScopeResponse(["orchestration:read"]), method: "bearer-access-token",
    client: { deviceType: "tablet", os: "Android" },
    issuedAt: "2026-11-20T09:00:00.000Z", expiresAt: "2026-12-20T09:00:00.000Z", lastConnectedAt: null, connected: false, current: false,
  };
  const link = {
    id: "link-1", ...m.authScopeResponse(["orchestration:read"]), subject: "pairing-link", label: "Harbor iPad",
    createdAt: "2026-11-27T08:58:00.000Z", expiresAt: "2026-11-27T09:13:00.000Z",
  };
  const events = [
    { version: 1, revision: 1, type: "snapshot", payload: { pairingLinks: [link], clientSessions: [phone] } },
    { version: 1, revision: 2, type: "clientUpserted", payload: tablet },
    { version: 1, revision: 3, type: "pairingLinkUpserted", payload: { ...link, label: "Harbor iPad 2" } },
    { version: 1, revision: 4, type: "pairingLinkRemoved", payload: { id: "link-1" } },
    { version: 1, revision: 5, type: "clientUpserted", payload: { ...phone, lastConnectedAt: "2026-11-27T09:00:00.000Z" } },
    { version: 1, revision: 6, type: "clientRemoved", payload: { sessionId: "session-gone" } },
  ].map((value) => S.encodeSync(S.toCodecJson(m.AuthAccessStreamEvent))(S.decodeUnknownSync(S.toCodecJson(m.AuthAccessStreamEvent))(value)));
  const accessPath = join(here, "..", "access-stream.json");
  const access = JSON.stringify(events, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(accessPath, "utf8") === access) {
      console.log("ok   access-stream.json matches the schemas");
    } else {
      failures += 1;
      console.log("FAIL access-stream.json is stale: run this script without --check, then swift test");
    }
  } else {
    writeFileSync(accessPath, access);
    console.log("wrote access-stream.json");
  }
}
process.exit(failures === 0 ? 0 : 1);
