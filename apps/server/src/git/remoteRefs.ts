import { trimAsciiWhitespace } from "@ankielcode/contracts";

export function parseRemoteNamesInGitOrder(stdout: string): ReadonlyArray<string> {
  const remoteNames: Array<string> = [];
  for (const line of stdout.split("\n")) {
    const remoteName = trimAsciiWhitespace(line);
    if (remoteName.length > 0) {
      remoteNames.push(remoteName);
    }
  }
  return remoteNames;
}

export function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return parseRemoteNamesInGitOrder(stdout).toSorted((a, b) => b.length - a.length);
}

export function parseRemoteRefWithRemoteNames(
  ref: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; branchName: string } | null {
  const trimmedRef = trimAsciiWhitespace(ref);
  if (trimmedRef.length === 0) {
    return null;
  }

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedRef.startsWith(remotePrefix)) {
      continue;
    }
    const branchName = trimmedRef.slice(remotePrefix.length);
    if (branchName.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedRef,
      remoteName,
      branchName,
    };
  }

  return null;
}
