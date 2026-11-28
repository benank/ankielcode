import { EnvironmentId } from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget, SshConnectionTarget } from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encodeCatalogJson = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
const decodeCatalogJson = Schema.decodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

const SSH_TARGET = new SshConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "ssh-remote",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: SSH_TARGET.label,
  target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

describe("ConnectionCatalogDocument", () => {
  it("loads a document with pull request routing grants from an older build and drops them", () => {
    const document = decodeCatalogJson(
      JSON.stringify({
        schemaVersion: 1,
        targets: [],
        profiles: [],
        credentials: [],
        githubRoutingPermissions: [
          { environmentId: ENVIRONMENT_ID, connectionKey: "key", permission: "read-write" },
        ],
      }),
    );
    expect(document).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    expect(JSON.parse(encodeCatalogJson(document))).not.toHaveProperty("githubRoutingPermissions");
  });

  it("replaces obsolete connection metadata when a route is registered over another", () => {
    const bearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const ssh = registerConnectionInCatalog(
      bearer,
      new SshConnectionRegistration({
        target: SSH_TARGET,
        profile: SSH_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(ssh.targets).toEqual([SSH_TARGET]);
    expect(ssh.profiles).toHaveLength(1);
    expect(ssh.credentials).toHaveLength(1);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("drops saved Ankiel Connect routes and profiles but keeps the direct ones", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [
        { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "bearer-1",
        },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "learned:environment-1:https://tunnel.example.test",
        },
      ],
      profiles: [
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer-1",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "https://remote.example.test",
          wsBaseUrl: "wss://remote.example.test",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: "learned:environment-1:https://tunnel.example.test",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "https://tunnel.example.test",
          wsBaseUrl: "wss://tunnel.example.test",
          learned: true,
          authorization: "ankiel-connect",
        },
      ],
      credentials: [{ connectionId: "bearer-1", credential: BEARER_CREDENTIAL }],
      remoteDpopTokens: [{ environmentId: ENVIRONMENT_ID, accessToken: "obsolete" }],
    });

    expect(decoded.targets.map((target) => target.connectionId)).toEqual(["bearer-1"]);
    expect(decoded.profiles.map((profile) => profile.connectionId)).toEqual(["bearer-1"]);
    expect(decoded.credentials).toHaveLength(1);
  });

  it("round-trips a saved document through encode and decode", () => {
    const document = registerConnectionInCatalog(
      registerConnectionInCatalog(
        EMPTY_CONNECTION_CATALOG_DOCUMENT,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ),
      new SshConnectionRegistration({
        target: SSH_TARGET,
        profile: SSH_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
      [BEARER_TARGET, SSH_TARGET],
    );
    const encoded = encodeCatalogJson(document);
    const decoded = decodeCatalogJson(encoded);
    expect(decoded).toEqual(document);
    expect(decoded.targets).toHaveLength(2);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile and its paired token beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([
      { connectionId: target.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    // Removing the route forgets its token too.
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).credentials).toEqual([]);
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withSsh = registerConnectionInCatalog(
      withBearer,
      new SshConnectionRegistration({
        target: SSH_TARGET,
        profile: SSH_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
      [BEARER_TARGET, SSH_TARGET],
    );
    expect(catalogRoutes(withSsh, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, SSH_TARGET]);
    expect(withSsh.credentials).toHaveLength(2);

    const sshOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [SSH_TARGET]);
    expect(sshOnly.targets).toEqual([SSH_TARGET]);
    expect(sshOnly.profiles).toEqual([SSH_PROFILE]);
    expect(sshOnly.credentials).toHaveLength(1);

    const bearerOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.profiles).toEqual([BEARER_PROFILE]);
    expect(bearerOnly.credentials).toHaveLength(1);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
      connectionId: "bearer-2",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [SSH_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, SSH_TARGET]).targets,
    ).toEqual([BEARER_TARGET, SSH_TARGET, other]);
  });
});
