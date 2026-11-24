import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:benank/ankielcode.git", "benank/ankielcode"],
  ["github.com:benank/ankielcode.git", "benank/ankielcode"],
  ["gitlab.com:Ankiel/platform/ankielcode", "Ankiel/platform/ankielcode"],
  ["https://github.com/benank/ankielcode.git", "benank/ankielcode"],
  ["https://github.com/benank/ankielcode.git?view=compact", "benank/ankielcode"],
  ["https://github.com/benank/ankielcode.git#section", "benank/ankielcode"],
  ["C:/repos/ankielcode", null],
])("reads the repository path of %s", (remoteUrl, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
});
