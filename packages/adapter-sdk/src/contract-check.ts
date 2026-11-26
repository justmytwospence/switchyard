import type * as protocol from "@switchyard/protocol";
import type * as contract from "./contract.js";
import type { ADAPTER_FEATURES, AdapterContext, Claim, ServerAdapter } from "./types.js";

/**
 * Compile-time proof that `contract.ts`, the dependency-free copy adapter authors take, is
 * interchangeable with the SDK's and the protocol's own types. A drift fails `tsc`.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const CONTRACT_MATCHES: {
  node: Same<contract.UINode, protocol.UINode>;
  toolView: Same<contract.ToolViewData, protocol.ToolViewData>;
  contribution: Same<contract.AdapterContribution, protocol.AdapterContribution>;
  response: Same<contract.InteractionResponse, protocol.InteractionResponse>;
  feature: Same<contract.AdapterFeature, (typeof ADAPTER_FEATURES)[number]>;
  kind: Same<contract.InteractionKind, protocol.InteractionKind>;
} = { node: true, toolView: true, contribution: true, response: true, feature: true, kind: true };

/** An adapter written against the contract is an SDK adapter, and an SDK context serves it. */
export const adapterFits = (a: contract.ServerAdapter): ServerAdapter => a;
export const contextFits = (c: AdapterContext): contract.AdapterContext => c;
export const claimFits = (c: contract.Claim): Claim => c;
