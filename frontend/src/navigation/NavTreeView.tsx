// src/navigation/NavTreeView.tsx
// Scrollable, collapsible navigation tree (left sidebar).
// - Derives from word metadata hierarchy (dynamic depth).
// - Auto-follows the reading position (highlights + scrolls the active node).
// - Clicking a node seeks the reader to that location.

import { useEffect, useMemo, useRef, useState } from "react";
import type { WordStream } from "../epub/types";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { buildNavTree, findNodePath } from "./tree";
import type { NavNode } from "./tree";

export interface NavTreeViewProps {
  stream: WordStream;
  /** Current word index (for auto-follow). */
  currentIndex: number;
  /** Called when a node is clicked — seek to this word index. */
  onSeek: (index: number) => void;
  /** Max tree depth (undefined = all metadata levels). */
  maxDepth?: number;
  theme?: Theme;
}

export function NavTreeView({ stream, currentIndex, onSeek, maxDepth, theme = "light" }: NavTreeViewProps) {
  const tree = useMemo(() => buildNavTree(stream.words, stream.chapterIndex, maxDepth), [stream, maxDepth]);

  // Track expanded node paths (set of "attr:value/attr:value" keys).
  // Default: nothing expanded — the tree starts collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const activePath = useMemo(() => findNodePath(tree, currentIndex), [tree, currentIndex]);
  const activeKey = activePath.map((n) => `${n.attribute}:${n.value}`).join("/");

  // Auto-scroll the active node into view (only visible if its ancestors
  // are expanded — we do NOT auto-expand, so the tree stays collapsed).
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const colors = themeTokens(theme);

  const renderNode = (node: NavNode, depth: number, pathKey: string): React.ReactNode => {
    const isActive = pathKey === activeKey;
    const isExpanded = expanded.has(pathKey);
    const hasChildren = node.children.length > 0;

    return (
      <div key={pathKey}>
        <div
          ref={isActive ? activeRef : undefined}
          onClick={() => {
            if (hasChildren) toggle(pathKey);
            onSeek(node.startIndex);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            paddingLeft: 8 + depth * 14,
            cursor: "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            background: isActive ? colors.active : "transparent",
            color: isActive ? colors.activeFg : colors.fg,
            borderRadius: 4,
            fontSize: 13,
          }}
          onMouseEnter={(e) => {
            if (!isActive) (e.currentTarget as HTMLDivElement).style.background = colors.hover;
          }}
          onMouseLeave={(e) => {
            if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        >
          <span style={{ width: 12, display: "inline-block", fontSize: 10 }}>
            {hasChildren ? (isExpanded ? "▾" : "▸") : ""}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.label}</span>
        </div>
        {hasChildren && isExpanded && node.children.map((c) => renderNode(c, depth + 1, `${pathKey}/${c.attribute}:${c.value}`))}
      </div>
    );
  };

  return (
    <div
      className="glass-scroll"
      style={{
        width: 260,
        height: "100%",
        overflowY: "auto",
        background: colors.panel,
        borderRight: `1px solid ${colors.border}`,
        padding: "8px 4px",
        boxSizing: "border-box",
        fontFamily: "system-ui",
      }}
    >
      {tree.roots.length === 0 ? (
        <div style={{ color: colors.fg, padding: 8, fontSize: 13 }}>No navigation structure.</div>
      ) : (
        tree.roots.map((r) => renderNode(r, 0, `${r.attribute}:${r.value}`))
      )}
    </div>
  );
}