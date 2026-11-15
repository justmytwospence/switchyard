import type { Panel } from "@switchyard/protocol";
import { useMemo, useState } from "react";
import { useContributions } from "../../sync/store";
import { useContributePalette } from "../palette/registry";
import { adapterCommandName } from "./adapterIdentity";

export function useAdapterCommands(sessionId: string | null) {
  const contributions = useContributions(sessionId);
  const [preview, setPreview] = useState<Panel | null>(null);
  const palette = useMemo(
    () => contributions.filter((p) => p.contribution?.placement === "palette.item"),
    [contributions],
  );
  const slash = useMemo(
    () => contributions.filter((p) => p.contribution?.placement === "slash.command"),
    [contributions],
  );
  useContributePalette(
    "code-adapters",
    palette.map((p) => ({
      id: JSON.stringify([sessionId, p.adapterId, p.contribution?.id]),
      title: p.title,
      subtitle: p.adapterId,
      group: "Extensions" as const,
      keywords: [
        p.adapterId,
        ...(p.contribution?.placement === "palette.item" ? (p.contribution.keywords ?? []) : []),
      ],
      run: () => setPreview(p),
    })),
  );
  return { slash, preview, setPreview, name: adapterCommandName };
}
