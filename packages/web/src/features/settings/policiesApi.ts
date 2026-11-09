import type {
  CreatePolicyRuleRequest,
  PolicyRule,
  PolicySettings,
  PolicyTestRequest,
  PolicyTestResult,
  UpdatePolicyRuleRequest,
  UpdatePolicySettingsRequest,
} from "@switchyard/protocol";
import { api, apiGet, apiPatch, apiPost, apiPut } from "../../sync/api";

const rulePath = (id: string) => `/api/policies/${encodeURIComponent(id)}`;
export const policiesApi = {
  list: () => apiGet<PolicyRule[]>("/api/policies"),
  create: (input: CreatePolicyRuleRequest) => apiPost<PolicyRule>("/api/policies", input),
  update: (id: string, input: UpdatePolicyRuleRequest) => apiPatch<PolicyRule>(rulePath(id), input),
  remove: (id: string, expectedRevision: number) =>
    api<void>(rulePath(id), { method: "DELETE", query: { expectedRevision } }),
  settings: () => apiGet<PolicySettings>("/api/policies/settings"),
  updateSettings: (input: UpdatePolicySettingsRequest) =>
    apiPut<PolicySettings>("/api/policies/settings", input),
  test: (input: PolicyTestRequest) => apiPost<PolicyTestResult>("/api/policies/test", input),
};
