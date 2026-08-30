import type { ForeignLibraryManifest, ForeignOutputType } from "./types";

export interface ForeignOutputFilter {
  type: ForeignOutputType;
  label: string;
}

const BUILTIN_OUTPUT_FILTERS: ForeignOutputFilter[] = [
  { type: "epub", label: "EPUB" },
  { type: "html", label: "HTML" },
  { type: "pdf", label: "PDF" },
  { type: "json", label: "JSON response" },
  { type: "sugarcube", label: "SugarCube" },
];

export function foreignOutputFilters(manifests: ForeignLibraryManifest[]): ForeignOutputFilter[] {
  const labels = new Map<ForeignOutputType, string>(BUILTIN_OUTPUT_FILTERS.map((filter) => [filter.type, filter.label]));
  for (const manifest of manifests) {
    for (const output of manifest.outputs) if (!labels.has(output.type)) labels.set(output.type, output.label);
  }
  const builtInTypes = BUILTIN_OUTPUT_FILTERS.map((filter) => filter.type);
  return [...labels]
    .sort(([left], [right]) => {
      const leftIndex = builtInTypes.indexOf(left);
      const rightIndex = builtInTypes.indexOf(right);
      if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    })
    .map(([type, label]) => ({ type, label }));
}

export function filterForeignLibraries(
  manifests: ForeignLibraryManifest[],
  outputType: ForeignOutputType | "all",
): ForeignLibraryManifest[] {
  if (outputType === "all") return manifests;
  return manifests.filter((manifest) => manifest.outputs.some((output) => output.type === outputType));
}
