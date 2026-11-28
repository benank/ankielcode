import type { ComposerContextClipboardFragment, ScopedThreadRef } from "@ankielcode/contracts";
import { threadContextRecord } from "@ankielcode/shared/composerContextReferences";
import { formatThreadLink } from "@ankielcode/shared/threadLinks";

import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface ThreadReferenceCopyTarget {
  readonly kind: "thread";
  /** The plain text: an Ankiel Code thread link. */
  readonly value: string;
  /** What a toast or palette row shows for the copy. */
  readonly description: string;
  /** Ankiel's clipboard format, which pastes a thread back into a composer as a chip. */
  readonly fragment?: ComposerContextClipboardFragment;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

/**
 * A thread link that pastes as a chip into a composer with access to the thread's environment.
 */
export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
  resolve: MFunctionType = mFallback,
): ThreadReferenceCopyTarget {
  const record = threadContextRecord(threadRef, title);
  return {
    kind: "thread",
    value: formatThreadLink(threadRef),
    description: record.title,
    fragment: { version: 1, source: { environmentId: threadRef.environmentId }, records: [record] },
    clipboardTarget: "thread",
    successTitle: resolve(msg("Thread copied")),
    failureTitle: resolve(msg("Failed to copy thread")),
  };
}
