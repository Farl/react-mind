import type { MindmapNode } from "../domain/mindmap";

/**
 * Computes WBS (Work Breakdown Structure) numbers for all nodes in a mind map.
 *
 * Numbering rules:
 * - Root nodes (parentId === null) are NOT numbered.
 * - Each root's subtree is numbered independently.
 * - Direct children of a root receive "1", "2", "3" …
 * - Grandchildren receive "1.1", "1.2", "2.1" … and so on recursively.
 *
 * Sibling order follows the same sort as the canvas renderer:
 *   primary key = node.order ascending, tie-break = title alphabetical.
 *
 * Returns a Map<nodeId, wbsLabel>.
 * Root nodes are absent from the map (they have no WBS label).
 */
export const computeWbsNumbers = (nodes: MindmapNode[]): Map<string, string> => {
  const result = new Map<string, string>();

  // Build children map grouped by parentId (immutable list construction)
  const childrenMap = new Map<string | null, MindmapNode[]>();
  nodes.forEach((node) => {
    const existing = childrenMap.get(node.parentId) ?? [];
    childrenMap.set(node.parentId, [...existing, node]);
  });

  // Sort each sibling list by order then title (matches MindmapCanvas groupByParent)
  childrenMap.forEach((list, key) => {
    childrenMap.set(
      key,
      [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    );
  });

  // DFS: assign numbers to all non-root nodes
  const traverse = (nodeId: string, prefix: string) => {
    const children = childrenMap.get(nodeId) ?? [];
    children.forEach((child, idx) => {
      const label = prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`;
      result.set(child.id, label);
      traverse(child.id, label);
    });
  };

  // Start from each root (parentId === null); roots themselves are not numbered
  const roots = childrenMap.get(null) ?? [];
  roots.forEach((root) => traverse(root.id, ""));

  return result;
};
