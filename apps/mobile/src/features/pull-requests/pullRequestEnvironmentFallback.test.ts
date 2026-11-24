import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@ankielcode/client-runtime/state/models";
import type { EnvironmentConnectionPhase } from "@ankielcode/client-runtime/connection";
import { EnvironmentId } from "@ankielcode/contracts";
import { pullRequestFallbackEnvironment } from "./pullRequestEnvironmentFallback";

const project = (environmentId: string, id: string, canonicalKey: string) =>
  ({
    environmentId,
    id,
    repositoryIdentity: { canonicalKey },
  }) as unknown as EnvironmentProject;

const projects = [
  project("laptop", "ankiel", "github.com/benank/ankielcode"),
  project("desktop", "other", "github.com/benank/other"),
  project("server", "ankiel-copy", "github.com/benank/ankielcode"),
];
const target = {
  environmentId: "laptop",
  projectId: "ankiel",
  repository: "benank/ankielcode",
  host: "github.com",
};
const environment = (
  environmentId: string,
  connectionState: EnvironmentConnectionPhase = "connected",
  isEnabled = true,
) => ({ environmentId: EnvironmentId.make(environmentId), connectionState, isEnabled });

describe("pullRequestFallbackEnvironment", () => {
  it("moves to a connected copy of the repository when the original is down", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("desktop"),
        environment("server"),
      ]),
    ).toEqual({ environmentId: "server", projectId: "ankiel-copy" });
  });

  it("stays put while the original is connected or nothing else holds the repository", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("laptop"),
        environment("server"),
      ]),
    ).toBe(null);
    expect(pullRequestFallbackEnvironment(target, projects, [environment("desktop")])).toBe(null);
  });

  it("derives the host from the original project when the route has none", () => {
    const { host: _host, ...hostless } = target;
    expect(pullRequestFallbackEnvironment(hostless, projects, [environment("server")])).toEqual({
      environmentId: "server",
      projectId: "ankiel-copy",
    });
  });
});
