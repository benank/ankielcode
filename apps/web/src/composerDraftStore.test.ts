import { Atom, AtomRegistry } from "effect/reactivity";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ankielcode/client-runtime/environment";
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RunId,
  ThreadId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderOptionSelection,
  type ScopedThreadRef,
} from "@ankielcode/contracts";
import { createModelSelection } from "@ankielcode/shared/model";

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

type ProviderOptionSelectionBag = ReadonlyArray<ProviderOptionSelection>;
type ProviderOptionSelectionsByProvider = Partial<Record<string, ProviderOptionSelectionBag>>;

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const result: Array<ProviderOptionSelection> = [];
  if (!options) return result;
  for (const [id, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "boolean") {
      result.push({ id, value });
    }
  }
  return result;
}

function selectionsByProvider(
  options: Partial<Record<ProviderDriverKind, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, bag] of Object.entries(options) as Array<
    [ProviderDriverKind, Record<string, string | boolean | undefined>]
  >) {
    result[provider] = toSelections(bag);
  }
  return result;
}
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { createMemoryStorage } from "./lib/storage";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  checkoutPullRequestUrlToLink,
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  resolveDraftPromotionNavigationTarget,
  restoreFailedDraftThread,
  subscribeDraftThreadPromotion,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  DraftId,
} from "./composerDraftStore";
import { waitForDraftHeroTransition } from "./components/chat/draftHeroTransition";
import { formatTerminalContextReference, type TerminalContextDraft } from "./lib/terminalContext";
import { createDeferredStorage } from "./lib/storage";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.make("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection {
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options));
}

function providerModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  return selectionsByProvider(options);
}

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const LEGACY_TEST_ENVIRONMENT_ID = EnvironmentId.make("__legacy__");

function threadKeyFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
): string {
  if (environmentId === LEGACY_TEST_ENVIRONMENT_ID) {
    return threadId;
  }
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined;
}

function draftByKey(key: string) {
  return useComposerDraftStore.getState().draftsByThreadKey[key] ?? undefined;
}

describe("composerDraftStore file attachments", () => {
  const threadId = ThreadId.make("thread-files");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("persists uploaded file references without including file contents", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [
      { ...makeFile("file-1"), source: { _tag: "pasted-text" as const } },
    ]);
    store.setFileUpload(threadRef, "file-1", TEST_ENVIRONMENT_ID, "pending-report-pdf");

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual(
      [
        {
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          attachmentId: "pending-report-pdf",
          environmentId: TEST_ENVIRONMENT_ID,
          source: { _tag: "pasted-text" },
        },
      ],
    );

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    expect(hydrated.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual([
      {
        type: "file",
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
        uploadedAttachmentId: "pending-report-pdf",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
        source: { _tag: "pasted-text" },
      },
    ]);
  });

  it("persists a pending file as a needs-reattach marker instead of dropping it", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [makeFile("file-pending")]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual(
      [
        {
          id: "file-pending",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
        },
      ],
    );

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    const hydratedFiles =
      hydrated.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files;
    expect(hydratedFiles).toEqual([
      {
        type: "file",
        id: "file-pending",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
      },
    ]);
    expect(hydratedFiles?.every(composerFileNeedsReattach)).toBe(true);
  });

  it("marks only the matching byte-less upload as missing", () => {
    const store = useComposerDraftStore.getState();
    const hydrated: ComposerFileAttachment = {
      ...makeFile("file-hydrated"),
      file: null,
      uploadedAttachmentId: "pending-old",
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    };
    const local: ComposerFileAttachment = {
      ...makeFile("file-local"),
      name: "local.txt",
      mimeType: "text/plain",
    };
    store.addFiles(threadRef, [hydrated, local]);
    store.setFileUpload(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-new");
    store.setFileUpload(threadRef, local.id, TEST_ENVIRONMENT_ID, "pending-local");

    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, OTHER_TEST_ENVIRONMENT_ID, "pending-new"),
    ).toBe(false);
    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-old"),
    ).toBe(false);
    expect(
      store.markFileUploadMissing(threadRef, local.id, TEST_ENVIRONMENT_ID, "pending-local"),
    ).toBe(false);

    expect(store.getComposerDraft(threadRef)?.files).toMatchObject([
      {
        id: hydrated.id,
        uploadedAttachmentId: "pending-new",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
      },
      {
        id: local.id,
        file: local.file,
        uploadedAttachmentId: "pending-local",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
      },
    ]);

    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-new"),
    ).toBe(true);
    const marker = store.getComposerDraft(threadRef)?.files[0];
    expect(marker && composerFileNeedsReattach(marker)).toBe(true);
    expect(marker?.uploadedAttachmentId).toBeUndefined();
    expect(marker?.uploadEnvironmentId).toBeUndefined();
  });

  it("enforces the combined file and image limit across separate updates", () => {
    const store = useComposerDraftStore.getState();
    const images = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
      makeImage({
        id: `image-${index}`,
        name: `image-${index}.png`,
        previewUrl: `blob:image-${index}`,
      }),
    );
    store.addImages(threadRef, images);
    store.addFiles(threadRef, [
      makeFile("file-accepted"),
      { ...makeFile("file-overflow"), name: "other.pdf" },
    ]);
    expect(
      store.addImage(
        threadRef,
        makeImage({ id: "image-overflow", name: "overflow.png", previewUrl: "blob:overflow" }),
      ),
    ).toBe(false);

    const draft = store.getComposerDraft(threadRef);
    expect(draft?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1);
    expect(draft?.files.map((file) => file.id)).toEqual(["file-accepted"]);
  });

  it("reattaches a DNG with an older generic-MIME marker at attachment capacity", () => {
    const store = useComposerDraftStore.getState();
    const file = new File(["raw"], "photo.DNG", { type: "image/x-adobe-dng" });
    const marker: ComposerFileAttachment = {
      type: "file",
      id: "dng-marker",
      name: file.name,
      mimeType: "application/octet-stream",
      sizeBytes: file.size,
      file: null,
    };
    store.addFiles(threadRef, [marker]);
    store.addImages(
      threadRef,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
        makeImage({
          id: `image-${index}`,
          name: `image-${index}.png`,
          previewUrl: `blob:image-${index}`,
        }),
      ),
    );

    const repicked: ComposerFileAttachment = {
      ...marker,
      id: "dng-repicked",
      mimeType: file.type,
      file,
    };
    store.addFiles(threadRef, [repicked]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files).toEqual([repicked]);
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("replaces a needs-reattach marker when the same file is picked again", () => {
    const store = useComposerDraftStore.getState();
    const marker: ComposerFileAttachment = { ...makeFile("file-marker"), file: null };
    store.addFiles(threadRef, [marker]);
    expect(store.getComposerDraft(threadRef)?.files.every(composerFileNeedsReattach)).toBe(true);

    const repicked = makeFile("file-repicked");
    store.addFiles(threadRef, [repicked]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files?.map((file) => file.id)).toEqual(["file-repicked"]);
    expect(files?.[0]?.file).not.toBeNull();
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });
});

describe("composerDraftStore context persistence", () => {
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("context-persistence"));
  const annotation: PreviewAnnotationPayload = {
    id: "retry-note",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    comment: "Keep the cart after a failed payment",
    elements: [],
    regions: [{ id: "error-region", rect: { x: 10, y: 20, width: 100, height: 50 } }],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-09-06T10:00:00.000Z",
  };

  beforeEach(resetComposerDraftStore);

  it("preserves snapshots and inline positions through repeated persistence and hydration", () => {
    const terminal = {
      ...makeTerminalContext({ id: "checkout-console" }),
      threadId: threadRef.threadId,
    };
    const store = useComposerDraftStore.getState();
    store.addTerminalContexts(threadRef, [terminal]);
    store.addPreviewAnnotation(threadRef, annotation);
    const terminalLink = formatTerminalContextReference(terminal);
    const prompt = `Inspect ${terminalLink}. Apply [Retry note](ankiel-context://v1/preview-annotation/preview-annotation_retry-note). Compare ${terminalLink} again.`;
    store.setPrompt(threadRef, prompt);
    let state = useComposerDraftStore.getState();
    const merge = useComposerDraftStore.persist.getOptions().merge!;

    for (let reload = 0; reload < 3; reload++) {
      state = merge(
        JSON.parse(JSON.stringify(partializeComposerDraftStoreState(state))),
        useComposerDraftStore.getInitialState(),
      );
      const draft = state.draftsByThreadKey[scopedThreadKey(threadRef)];
      expect(draft?.prompt).toBe(prompt);
      expect(draft?.terminalContexts).toEqual([terminal]);
      expect(draft?.previewAnnotations).toEqual([annotation]);
    }
  });

  // regression: #35010 typing a draft in one tab erased drafts another tab saved after it loaded
  it("keeps a draft another tab saved after this tab loaded", async () => {
    const sharedStorage = createMemoryStorage();
    vi.stubGlobal("localStorage", sharedStorage);
    vi.stubGlobal("window", new EventTarget());
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const thisTab = await import("./composerDraftStore");
      vi.resetModules();
      const otherTab = await import("./composerDraftStore");
      const betaRef = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("beta-new-thread"));
      const alphaRef = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("alpha-new-thread"));

      otherTab.useComposerDraftStore.getState().setPrompt(betaRef, "beta draft");
      await vi.advanceTimersByTimeAsync(300);
      window.dispatchEvent(
        Object.assign(new Event("storage"), { key: COMPOSER_DRAFT_STORAGE_KEY }),
      );
      thisTab.useComposerDraftStore.getState().setPrompt(alphaRef, "alpha draft");
      await vi.advanceTimersByTimeAsync(300);

      const saved = JSON.parse(sharedStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) as string);
      expect(saved.state.draftsByThreadKey[scopedThreadKey(betaRef)]?.prompt).toBe("beta draft");
      expect(saved.state.draftsByThreadKey[scopedThreadKey(alphaRef)]?.prompt).toBe("alpha draft");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

type PromotionShell = NonNullable<
  Parameters<typeof resolveDraftPromotionNavigationTarget>[0]["serverThread"]
>;

function draftPromotionHarness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  onTestFinished(() => registry.dispose());
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const threadRefsAtom = Atom.make<ReadonlyArray<ScopedThreadRef>>([]);
  const shellAtoms = new Map<string, Atom.Writable<PromotionShell | null>>();
  const shellAtom = (ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    let atom = shellAtoms.get(key);
    if (!atom) {
      atom = Atom.make<PromotionShell | null>(null);
      shellAtoms.set(key, atom);
    }
    return atom;
  };
  onTestFinished(
    subscribeDraftThreadPromotion({ registry, threadRefsAtom, threadShellAtom: shellAtom }),
  );
  flush();
  return {
    flush,
    arrive(ref: ScopedThreadRef, shell: PromotionShell | null = null) {
      registry.set(shellAtom(ref), shell);
      registry.set(threadRefsAtom, [...registry.get(threadRefsAtom), ref]);
      flush();
    },
    updateShell(ref: ScopedThreadRef, shell: PromotionShell) {
      registry.set(shellAtom(ref), shell);
      flush();
    },
  };
}

describe("composerDraftStore draft promotion", () => {
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("project-promotion"));
  const draftId = DraftId.make("draft-promotion");
  const threadId = ThreadId.make("thread-promotion");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const preparingRun = {
    runId: RunId.make("run-promotion"),
    status: "preparing" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  };

  beforeEach(resetComposerDraftStore);

  it("stays on the draft until the server owns the send", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: threadRef,
        serverThread: { latestRun: preparingRun, latestUserMessageAt: null },
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: threadRef,
        serverThread: { latestRun: null, latestUserMessageAt: null },
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    const persisted = { latestRun: preparingRun, latestUserMessageAt: "2026-03-29T00:00:00.000Z" };
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: threadRef,
        serverThread: persisted,
        backgroundSubmissionPending: false,
      }),
    ).toBe(threadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: threadRef,
        serverThread: persisted,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });

  it("marks a draft promoting when its reserved thread arrives, then finalizes into it", async () => {
    const h = draftPromotionHarness();
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "typed during setup");
    h.flush();
    expect(store.getDraftSession(draftId)?.promotedTo).toBeNull();

    h.arrive(threadRef, { latestRun: preparingRun, latestUserMessageAt: null });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toEqual(
      threadRef,
    );

    h.updateShell(threadRef, {
      latestRun: preparingRun,
      latestUserMessageAt: "2026-03-29T00:00:00.000Z",
    });
    await waitForDraftHeroTransition();

    const state = useComposerDraftStore.getState();
    expect(state.getDraftSession(draftId)).toBeNull();
    expect(state.getPromotedDraftRedirect(draftId)).toEqual(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("typed during setup");
  });

  it("holds a background submission on its draft until the send settles", async () => {
    const h = draftPromotionHarness();
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    beginBackgroundDraftSubmissionByRef(threadRef);
    h.arrive(threadRef, {
      latestRun: preparingRun,
      latestUserMessageAt: "2026-03-29T00:00:00.000Z",
    });
    await waitForDraftHeroTransition();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toEqual(
      threadRef,
    );

    clearBackgroundDraftSubmissionByRef(threadRef);
    h.flush();
    await waitForDraftHeroTransition();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  });

  it("does not finalize a draft whose send failed and was restored", async () => {
    const h = draftPromotionHarness();
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    const sent = useComposerDraftStore.getState().getDraftSession(draftId)!;
    h.arrive(threadRef, {
      latestRun: { ...preparingRun, status: "failed" as const },
      latestUserMessageAt: null,
    });
    restoreFailedDraftThread(draftId, sent, ThreadId.make("retry-thread"));
    h.flush();
    await waitForDraftHeroTransition();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(
      "retry-thread",
    );
  });
});

describe("composerDraftStore model seed migration", () => {
  const staleDraftId = DraftId.make("draft-legacy-stale-model");
  const explicitDraftId = DraftId.make("draft-legacy-explicit-model");
  const typedDraftId = DraftId.make("draft-legacy-typed-model");
  const staleThreadId = ThreadId.make("thread-legacy-stale-model");
  const explicitThreadId = ThreadId.make("thread-legacy-explicit-model");
  const typedThreadId = ThreadId.make("thread-legacy-typed-model");
  const serverThreadId = ThreadId.make("thread-server-model");
  const serverThreadKey = scopedThreadKey(scopeThreadRef(TEST_ENVIRONMENT_ID, serverThreadId));
  const projectId = ProjectId.make("project-model-migration");
  const logicalProjectKey = `${TEST_ENVIRONMENT_ID}:/tmp/project-model-migration`;

  const draftThread = (threadId: ThreadId) => ({
    threadId,
    environmentId: TEST_ENVIRONMENT_ID,
    projectId,
    logicalProjectKey,
    createdAt: "2026-08-01T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
    promotedTo: null,
  });

  beforeEach(async () => {
    resetComposerDraftStore();
    await useComposerDraftStore.persist.clearStorage();
  });

  afterEach(async () => {
    await useComposerDraftStore.persist.clearStorage();
  });

  it.each([1, 2])(
    "keeps the legacy sticky Codex selection when v%s storage omitted the provider",
    async (version) => {
      vi.useFakeTimers();
      try {
        const stickySelection = modelSelection(CODEX_DRIVER, "gpt-5.6-terra", {
          reasoningEffort: "xhigh",
        });
        const storage = useComposerDraftStore.persist.getOptions().storage;
        expect(storage).toBeDefined();
        storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
          version,
          state: {
            draftsByThreadId: {},
            draftThreadsByThreadId: {},
            projectDraftThreadIdByProjectId: {},
            stickyModel: stickySelection.model,
            stickyModelOptions: providerModelOptions({
              [CODEX_DRIVER]: { reasoningEffort: "xhigh" },
            }),
          },
        } as never);
        await vi.advanceTimersByTimeAsync(300);

        await useComposerDraftStore.persist.rehydrate();

        expect(useComposerDraftStore.getState()).toMatchObject({
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
          stickyActiveProvider: null,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("strips seeded models only from empty draft sessions when upgrading storage", async () => {
    vi.useFakeTimers();
    try {
      const staleSelection = modelSelection(CODEX_DRIVER, "gpt-5.4");
      const stickySelection = modelSelection(CODEX_DRIVER, "gpt-5.6-terra", {
        reasoningEffort: "xhigh",
      });
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 8,
        state: {
          draftsByThreadKey: {
            [staleDraftId]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              runtimeMode: "approval-required",
            },
            [typedDraftId]: {
              prompt: "keep this prompt",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
            [explicitDraftId]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              modelSelectionExplicit: true,
            },
            [serverThreadKey]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
          },
          draftThreadsByThreadKey: {
            [staleDraftId]: draftThread(staleThreadId),
            [explicitDraftId]: draftThread(explicitThreadId),
            [typedDraftId]: draftThread(typedThreadId),
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {
            [logicalProjectKey]: staleDraftId,
          },
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
          stickyActiveProvider: CODEX_INSTANCE,
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      expect(draftByKey(staleDraftId)).toMatchObject({
        modelSelectionByProvider: {},
        activeProvider: null,
        runtimeMode: "approval-required",
      });
      expect(draftByKey(typedDraftId)).toMatchObject({
        prompt: "keep this prompt",
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(draftByKey(explicitDraftId)).toMatchObject({
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
        modelSelectionExplicit: true,
      });
      expect(draftByKey(serverThreadKey)).toMatchObject({
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[staleDraftId]).toMatchObject({
        environmentId: TEST_ENVIRONMENT_ID,
        projectId,
        logicalProjectKey,
      });
      expect(useComposerDraftStore.getState()).toMatchObject({
        stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
        stickyActiveProvider: CODEX_INSTANCE,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps v8 file-only draft sessions and their seeded models", async () => {
    vi.useFakeTimers();
    try {
      const uploadedDraftId = DraftId.make("draft-legacy-uploaded-file");
      const markerDraftId = DraftId.make("draft-legacy-file-marker");
      const uploadedThreadId = ThreadId.make("thread-legacy-uploaded-file");
      const markerThreadId = ThreadId.make("thread-legacy-file-marker");
      const staleSelection = modelSelection(CODEX_DRIVER, "gpt-5.4");
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 8,
        state: {
          draftsByThreadKey: {
            [uploadedDraftId]: {
              prompt: "",
              attachments: [],
              files: [
                {
                  id: "file-uploaded",
                  name: "uploaded-report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 128,
                  attachmentId: "attachment-uploaded",
                  environmentId: TEST_ENVIRONMENT_ID,
                },
              ],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
            [markerDraftId]: {
              prompt: "",
              attachments: [],
              files: [
                {
                  id: "file-needs-reattach",
                  name: "local-notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 64,
                },
              ],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              runtimeMode: "approval-required",
            },
          },
          draftThreadsByThreadKey: {
            [uploadedDraftId]: draftThread(uploadedThreadId),
            [markerDraftId]: draftThread(markerThreadId),
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
          stickyModelSelectionByProvider: {},
          stickyActiveProvider: null,
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      expect(draftByKey(uploadedDraftId)).toMatchObject({
        files: [
          {
            id: "file-uploaded",
            name: "uploaded-report.pdf",
            uploadedAttachmentId: "attachment-uploaded",
            uploadEnvironmentId: TEST_ENVIRONMENT_ID,
          },
        ],
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(draftByKey(markerDraftId)).toMatchObject({
        files: [
          {
            id: "file-needs-reattach",
            name: "local-notes.txt",
            file: null,
          },
        ],
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
        runtimeMode: "approval-required",
      });
      expect(draftByKey(markerDraftId)?.files.every(composerFileNeedsReattach)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("upgrades v5 selections that name a provider and keep options in an object", async () => {
    vi.useFakeTimers();
    try {
      const legacySelection = {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "high", fastMode: true },
      };
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 5,
        state: {
          draftsByThreadKey: {
            [serverThreadKey]: {
              prompt: "keep this draft",
              attachments: [],
              modelSelectionByProvider: { codex: legacySelection },
              activeProvider: "codex",
            },
          },
          draftThreadsByThreadKey: {},
          stickyModelSelectionByProvider: { codex: legacySelection },
          stickyActiveProvider: "codex",
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      const upgraded = modelSelection(CODEX_DRIVER, "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: true,
      });
      expect(draftByKey(serverThreadKey)).toMatchObject({
        prompt: "keep this draft",
        modelSelectionByProvider: { [CODEX_INSTANCE]: upgraded },
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({
        [CODEX_INSTANCE]: upgraded,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDeferredStorage", () => {
  const serialize = vi.fn((value: string) => `s:${value}`);

  beforeEach(() => {
    vi.useFakeTimers();
    serialize.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush serializes and writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v1");

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });
});

describe("composerDraftStore checkout pull request", () => {
  const projectId = ProjectId.make("project-checkout");
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);
  const otherProjectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("project-other"));
  const threadId = ThreadId.make("thread-checkout");
  const draftId = DraftId.make("draft-checkout");
  const url = "https://github.com/acme/widgets/pull/42";
  const checkout = { url, branch: "feature/pr-42" };

  beforeEach(() => {
    resetComposerDraftStore();
  });

  const store = () => useComposerDraftStore.getState();
  const toLink = () => checkoutPullRequestUrlToLink(store().getDraftSession(draftId));

  function draftOnMain() {
    store().setProjectDraftThreadId(projectRef, draftId, { threadId, branch: "main" });
  }

  // GitActionsControl's live branch sync writes the git status branch onto the draft. The status
  // refresh after a checkout is forked server-side, so the prepare response lands first and the
  // sync replays the stale pre-checkout branch before the fresh status corrects it.
  function liveBranchSync(branch: string) {
    store().setDraftThreadContext(draftId, {
      branch,
      worktreePath: null,
      environmentSelection: "manual",
    });
  }

  it("still links after a local checkout the live branch sync briefly reverts", () => {
    draftOnMain();
    store().setDraftThreadContext(draftId, {
      branch: checkout.branch,
      worktreePath: null,
      envMode: "local",
      checkoutPullRequest: checkout,
    });
    liveBranchSync("main");
    liveBranchSync(checkout.branch);

    expect(toLink()).toBe(url);
  });

  it("does not link once the draft has moved to another branch", () => {
    draftOnMain();
    store().setDraftThreadContext(draftId, {
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    liveBranchSync("main");

    expect(toLink()).toBeNull();
  });

  it("is dropped when cleared or when the draft moves to another project", () => {
    store().setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    store().setDraftThreadContext(draftId, { checkoutPullRequest: null });
    expect(store().getDraftSession(draftId)?.checkoutPullRequest).toBeUndefined();

    store().setDraftThreadContext(draftId, {
      checkoutPullRequest: checkout,
      worktreeRepositories: ["/work/api"],
    });
    // An unrelated change keeps the repository choice; an empty choice is still a choice.
    store().setDraftThreadContext(draftId, { envMode: "worktree" });
    expect(store().getDraftSession(draftId)?.worktreeRepositories).toEqual(["/work/api"]);
    store().setDraftThreadContext(draftId, { worktreeRepositories: [] });
    expect(store().getDraftSession(draftId)?.worktreeRepositories).toEqual([]);

    store().setDraftThreadContext(draftId, { projectRef: otherProjectRef });
    expect(store().getDraftSession(draftId)?.checkoutPullRequest).toBeUndefined();
    expect(store().getDraftSession(draftId)?.worktreeRepositories).toBeUndefined();
  });

  it("persists the pull request and still restores drafts saved without one", async () => {
    vi.useFakeTimers();
    try {
      await useComposerDraftStore.persist.clearStorage();
      const legacyDraftId = DraftId.make("draft-before-checkout-links");
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      const persistedDraftThread = (id: ThreadId) => ({
        threadId: id,
        environmentId: TEST_ENVIRONMENT_ID,
        projectId,
        logicalProjectKey: scopedProjectKey(projectRef),
        createdAt: "2026-08-01T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: checkout.branch,
        worktreePath: null,
        envMode: "local",
        startFromOrigin: false,
        promotedTo: null,
      });
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 9,
        state: {
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {
            [draftId]: {
              ...persistedDraftThread(threadId),
              checkoutPullRequest: checkout,
              worktreeRepositories: ["/work/api"],
            },
            [legacyDraftId]: persistedDraftThread(ThreadId.make("thread-legacy")),
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {
            [scopedProjectKey(projectRef)]: draftId,
          },
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      expect(toLink()).toBe(url);
      const legacy = store().getDraftSession(legacyDraftId);
      expect(legacy).toMatchObject({ branch: checkout.branch });
      expect(checkoutPullRequestUrlToLink(legacy)).toBeNull();
      expect(
        partializeComposerDraftStoreState(store()).draftThreadsByThreadKey[draftId],
      ).toMatchObject({ checkoutPullRequest: checkout, worktreeRepositories: ["/work/api"] });
      expect(legacy).not.toHaveProperty("worktreeRepositories");
    } finally {
      await useComposerDraftStore.persist.clearStorage();
      vi.useRealTimers();
      resetComposerDraftStore();
    }
  });
});
