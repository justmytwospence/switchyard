import type { Panel } from "@switchyard/protocol";
import { useEffect, useMemo, useState } from "react";
import { useContributions, useSyncStore } from "../../sync/store";
import { useContributePalette } from "../palette/registry";
import { isAdapterViewStale } from "./AdapterPanel";
import { adapterCommandName } from "./adapterIdentity";

export function useAdapterCommands(sessionId: string | null) {
  const contributions = useContributions(sessionId);
  const generation = useSyncStore((s) =>
    sessionId ? s.sessions[sessionId]?.adapterGeneration : undefined,
  );
  const [preview, setPreview] = useState<Panel | null>(null);
  useEffect(() => {
    setPreview((p) =>
      p && (p.sessionId !== sessionId || isAdapterViewStale(p.adapterGeneration, generation))
        ? null
        : p,
    );
  }, [sessionId, generation]);
  const palette = useMemo(
    () =>
      contributions.filter(
        (p) =>
          p.contribution?.placement === "palette.item" &&
          !isAdapterViewStale(p.adapterGeneration, generation),
      ),
    [contributions, generation],
  );
  const slash = useMemo(
    () =>
      contributions.filter(
        (p) =>
          p.contribution?.placement === "slash.command" &&
          !isAdapterViewStale(p.adapterGeneration, generation),
      ),
    [contributions, generation],
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
