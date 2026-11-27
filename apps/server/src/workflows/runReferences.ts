// What a run touched, for a person reading the run: the issue that started it, the one a step
// commented on. Anything that touches something calls `noteReference`; a new kind of thing is a
// new caller, and nothing else changes.
import { type IssueRef, type IssueState, WorkflowReferenceKind } from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type { ReferenceInput, WorkflowStore } from "./WorkflowStore.ts";

/** Keeps what the step whose code is running touches, against that step. */
export class StepReferences extends Context.Service<
  StepReferences,
  { readonly note: (reference: ReferenceInput) => Effect.Effect<void> }
>()("@ankielcode/server/workflows/runReferences/StepReferences") {}

/** Keep that `runId` touched `reference`, from `step` or, with none, from what started it. */
export const noteFor = (
  store: WorkflowStore["Service"],
  runId: string,
  step: string | null,
  reference: ReferenceInput,
): Effect.Effect<void> =>
  store.referenceNoted(runId, step, reference).pipe(
    // Only for a person to read: a step must never fail or wait over it.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not keep what a workflow run touched", {
        runId,
        step,
        kind: reference.kind,
        cause: Cause.pretty(cause),
      }),
    ),
  );

/** Keep that the running step touched `reference`. Outside a step it does nothing. */
export const noteReference = (reference: ReferenceInput): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(StepReferences), (current) =>
    current._tag === "None" ? Effect.void : current.value.note(reference),
  );

export const stepReferences = (
  store: WorkflowStore["Service"],
  runId: string,
  step: string,
): Context.Context<StepReferences> =>
  Context.make(StepReferences, { note: (reference) => noteFor(store, runId, step, reference) });

/** An issue, with its title and where it stands when the toucher read them. */
export const issueReference = (
  ref: IssueRef,
  seen?: { readonly title: string; readonly url: string; readonly state: IssueState },
): ReferenceInput => ({
  kind: WorkflowReferenceKind.issue,
  key: JSON.stringify([ref.tracker, ref.host ?? "", ref.scope.toLowerCase(), ref.key]),
  address: {
    projectId: ref.projectId,
    tracker: ref.tracker,
    ...(ref.host === undefined ? {} : { host: ref.host }),
    scope: ref.scope,
    key: ref.key,
  } satisfies Schema.Json,
  title: seen?.title ?? "",
  url: seen?.url,
  state: seen?.state.category,
});
