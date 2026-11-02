import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { makeRepo, type TempRepo } from "./git-repo.js";
export {
  type MockModelServer,
  type MockReply,
  type MockRequest,
  type MockRule,
  type MockScript,
  type MockToolCall,
  startMockModel,
  toMockRequest,
  when,
} from "./mock-model-server.js";
export {
  type MockOidc,
  type MockOidcClaims,
  type MockOidcOptions,
  type MockOidcTokenRequest,
  startMockOidc,
} from "./mock-oidc.js";
export { piBin, realPiSkipReason, requirePi, skipRealPi } from "./pi-bin.js";
export { makePiEnv, type PiEnv, type PiEnvOptions } from "./pi-env.js";

/** Absolute path of the compiled fixture extension, for `pi -e`. */
export function fixtureExtensionPath(): string {
  const sibling = fileURLToPath(new URL("./fixture-extension.js", import.meta.url));
  if (existsSync(sibling)) return sibling;
  // Running from src/ (tests): use the compiled copy.
  return fileURLToPath(new URL("../dist/fixture-extension.js", import.meta.url));
}
