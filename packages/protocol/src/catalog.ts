import { z } from "zod";

export const CatalogRepository = z.strictObject({
  authority: z.string().min(1),
  externalId: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  webUrl: z.url({ protocol: /^https$/ }),
  cloneUrl: z.url({ protocol: /^https$/ }),
  defaultBranch: z.string().nullable(),
});
export type CatalogRepository = z.infer<typeof CatalogRepository>;

export const CatalogAccountType = z.enum(["personal", "organization"]);
export type CatalogAccountType = z.infer<typeof CatalogAccountType>;

export const CatalogConnectionStatus = z.object({
  id: z.string(),
  account: z.string(),
  accountType: CatalogAccountType,
  state: z.enum(["pending", "ready", "stale", "suspended", "removed", "disconnected"]),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  installUrl: z.string().nullable(),
  manageUrl: z.string().nullable(),
});
export type CatalogConnectionStatus = z.infer<typeof CatalogConnectionStatus>;

export const CheckoutPreviewRequest = z.strictObject({
  hostId: z.string().min(1),
  folderName: z.string().min(1).max(128).optional(),
});
export const CheckoutProvisionRequest = z.strictObject({ previewId: z.string().min(1).max(128) });

export const isListedProject = (project: { catalog?: { state: string } }): boolean =>
  project.catalog?.state === "listed";
