import { makeSecretProviderDefinitionRegistry } from "@ankielcode/secret-provider-core/shared/definition";
import * as OnePassword from "@ankielcode/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
