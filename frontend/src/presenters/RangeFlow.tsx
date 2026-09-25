import { Fragment, type ReactNode } from "react";
import type { ReaderFlowNode } from "../interactions/flow";
import type { RangeLayout } from "./types";

function safeLink(value?: string): string | undefined {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
/** Group the visible canonical word nodes, including clipped viewport ranges. */
export function RangeFlow({ nodes, layouts = [], render }: {
  nodes: ReaderFlowNode[]; layouts?: RangeLayout[]; render(node: ReaderFlowNode): ReactNode;
}) {
  const groups: { key: string; layout?: RangeLayout; nodes: ReaderFlowNode[] }[] = [];
  let rangeIndex = 0;
  for (const node of nodes) {
    const index = node.kind === "word" ? node.word.index : node.kind === "interaction" ? node.interaction.boundary : node.presentation.boundary;
    while (layouts[rangeIndex] && layouts[rangeIndex].end <= index) rangeIndex++;
    const candidate = layouts[rangeIndex];
    const layout = candidate && candidate.start <= index && index < candidate.end ? candidate : undefined;
    const key = layout?.id ?? `plain:${rangeIndex}`;
    if (groups[groups.length - 1]?.key !== key) groups.push({ key, layout, nodes: [] });
    groups[groups.length - 1]!.nodes.push(node);
  }
  return <>{groups.map((group, index) => {
    const content = group.nodes.map(render);
    const layout = group.layout;
    if (!layout) return <Fragment key={index}>{content}</Fragment>;
    if (layout.kind === "heading") return <div key={layout.id} role="heading" aria-level={layout.level} className="presenter-heading">{content}</div>;
    if (layout.kind === "post") {
      const url = safeLink(layout.url);
      return <article key={layout.id} className="presenter-post">
        <header>{layout.reposter && <span>{layout.reposter} reposted</span>}<strong>{layout.author ?? "Bluesky post"}</strong>
          {layout.timestamp && Number.isFinite(Date.parse(layout.timestamp)) && <time dateTime={layout.timestamp}>{new Date(layout.timestamp).toLocaleString()}</time>}
          {url && <a href={url} target="_blank" rel="noopener noreferrer">View post ↗</a>}
        </header><div>{content}</div>
      </article>;
    }
    return <div key={layout.id} className="presenter-paragraph">{content}</div>;
  })}</>;
}
