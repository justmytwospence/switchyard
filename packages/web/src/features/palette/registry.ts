import { useEffect } from "react";
import { create } from "zustand";
import type { ShortcutId } from "./shortcuts";

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  group: "Sessions" | "Tasks" | "Projects" | "Hosts" | "Settings" | "Actions" | "Extensions";
  keywords?: string[];
  activityAt?: string;
  shortcut?: ShortcutId;
  run: () => void;
}

interface PaletteStore {
  open: boolean;
  helpOpen: boolean;
  providers: Record<string, PaletteItem[]>;
  setOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
  contribute(id: string, items: PaletteItem[]): void;
  withdraw(id: string): void;
}

export const usePalette = create<PaletteStore>()((set) => ({
  open: false,
  helpOpen: false,
  providers: {},
  setOpen: (open) => set({ open }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  contribute: (id, items) => set((s) => ({ providers: { ...s.providers, [id]: items } })),
  withdraw: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.providers;
      return { providers: rest };
    }),
}));

/** Contribute items to the palette while the calling component is mounted. */
export function useContributePalette(id: string, items: PaletteItem[]): void {
  const contribute = usePalette((s) => s.contribute);
  const withdraw = usePalette((s) => s.withdraw);
  useEffect(() => {
    contribute(id, items);
  });
  useEffect(() => () => withdraw(id), [id, withdraw]);
}
