import { expect, it } from "@effect/vitest";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

it.each([
  "C:/repos/project",
  "C:\\repos\\project",
  "/srv/git/repo.git",
  "./team:group/repo",
  "file:///srv/git/repo.git",
  "hg::team/repo",
  "codecommit::us-east-1://repo",
])("finds no host in %s, which git does not read as SSH", (remoteUrl) => {
  expect(sourceControlDefinitions.recognizeRemote(remoteUrl)).toBeNull();
});

it.each([
  ["https://github.com/Acme/Web/issues/42", "github", "github.com", "acme/web", "42"],
] as const)("reads %s as an issue on its host", (url, kind, host, scope, key) => {
  const parsed = sourceControlDefinitions.parseIssueUrl(url);
  expect(parsed?.definition.kind).toBe(kind);
  expect(parsed?.link).toEqual({ host, scope, key });
});

it.each([
  "https://github.com/acme/web/pull/42",
  "https://example.test/acme/web/issues/42",
  "https://github.com/acme/web/issues/0",
])("does not read %s as an issue", (url) => {
  expect(sourceControlDefinitions.parseIssueUrl(url)).toBeNull();
});
