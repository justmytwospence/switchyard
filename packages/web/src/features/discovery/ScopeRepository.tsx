import type { Project, Scope } from "@switchyard/protocol";
import { useId } from "react";
import { Select } from "../../components/ui/Select";
import { cn } from "../../lib/cn";
import { discoveryContext, discoveryProjects, scopeRepositoryLabel } from "./model";

export interface ScopeRepositoryProps {
  scope: Scope | null;
  projects: readonly Pick<Project, "id" | "name">[];
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  /** A scope control already names the scope (for example, in Board's header). */
  scopeLabelVisible?: boolean;
  className?: string;
}

/** A local refinement only. The caller owns query/selection and resets them on scope changes. */
export function ScopeRepository({
  scope,
  projects,
  projectId,
  onProjectChange,
  scopeLabelVisible = false,
  className,
}: ScopeRepositoryProps) {
  const id = useId();
  const { coverage, fixedProjectId } = discoveryContext(scope, projects);
  const covered = discoveryProjects(scope, projects);
  const fixed = fixedProjectId ? covered.find((p) => p.id === fixedProjectId) : undefined;
  if (fixed && scope) {
    const label = scopeRepositoryLabel(scope, fixed, scopeLabelVisible);
    return label ? <span className={cn("text-sm", className)}>{label}</span> : null;
  }
  if (coverage === "pins" || covered.length === 0) return null;
  const selected = covered.some((p) => p.id === projectId) ? projectId : null;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        Repository
      </label>
      <Select
        id={id}
        value={selected ?? ""}
        onChange={(e) => onProjectChange(e.target.value || null)}
      >
        <option value="">All repositories</option>
        {covered.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
