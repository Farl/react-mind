import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { EdgeStyle, LayoutMode, MindmapNode } from "../domain/mindmap";
import { getDescendantIds } from "../domain/mindmap";
import { computeWbsNumbers } from "../utils/wbsNumbers";

type PositionedNode = {
  node: MindmapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: "left" | "right" | "root" | "down" | "up";
  aligned?: boolean; // true = tree-chart mode (parent at top, trunk edges)
  /** The parent's aligned & direction values — used for edge rendering to parent */
  parentAligned?: boolean;
  parentDirection?: "left" | "right" | "root" | "down" | "up";
};

type MindmapCanvasProps = {
  nodes: MindmapNode[];
  selectedNodeIds: string[];
  collapsedNodeIds: string[];
  editable: boolean;
  layoutMode: LayoutMode;
  showWbsNumbers?: boolean;
  onSelectNode: (nodeId: string | null) => void;
  onToggleNodeSelection: (nodeId: string) => void;
  onSelectNodes: (nodeIds: string[]) => void;
  onRenameNode: (nodeId: string, title: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onMoveNode: (nodeId: string, nextParentId: string, nextIndex: number) => void;
  onMoveRootNode: (nodeId: string, x: number, y: number) => void;
  onAddRootNode: (x: number, y: number) => void;
};

const NODE_WIDTH = 170;
const NODE_HEIGHT = 42;
const ROOT_NODE_WIDTH = 200;
const ROOT_NODE_HEIGHT = 52;
const CANVAS_PAD = 80;

/** Scaled, capped increment: `min(max(0, count - 1) * multiplier, cap)` */
const cappedIncrement = (count: number, multiplier: number, cap: number): number =>
  Math.min(Math.max(0, count - 1) * multiplier, cap);

/** Horizontal gap between parent and children (depth-axis in horizontal layouts).
 *  maxChildWidth: widest child subtreeWidth — wider children (e.g. org-chart) push the gap out. */
const dynamicBetweenGap = (childCount: number, aligned: boolean, maxChildWidth: number = NODE_WIDTH): number => {
  const base = aligned ? 42 : 10;
  const countBonus = cappedIncrement(childCount, 4, 30);
  const widthExtra = Math.max(0, maxChildWidth - NODE_WIDTH);
  return base + countBonus + widthExtra;
};

/** Vertical gap between depth levels (depth-axis in vertical layouts). */
const dynamicVLevelGap = (childCount: number): number =>
  64 + cappedIncrement(childCount, 4, 30);

/** Horizontal sibling gap in vertical layouts. */
const dynamicHNodeGap = (siblingCount: number): number =>
  20 + cappedIncrement(siblingCount, 3, 24);

/** Vertical sibling gap in horizontal layouts. */
const dynamicVGap = (siblingCount: number): number =>
  22 + cappedIncrement(siblingCount, 2, 16);
const MIN_SCALE = 0.5;

// Shared empty map reused when WBS numbers are disabled (avoids allocating a new map on every render)
const EMPTY_WBS_MAP = new Map<string, string>();
const MAX_SCALE = 2;
const SCALE_STEP = 0.1;

type DraggingState = {
  nodeId: string;
  parentId: string;
  currentY: number;
};

type RootDraggingState = {
  nodeId: string;
  startLayoutX: number;
  startLayoutY: number;
  startPointerX: number;
  startPointerY: number;
};

const groupByParent = (nodes: MindmapNode[]) => {
  const childrenMap = new Map<string | null, MindmapNode[]>();
  nodes.forEach((node) => {
    const list = childrenMap.get(node.parentId) || [];
    list.push(node);
    childrenMap.set(node.parentId, list);
  });

  childrenMap.forEach((list, key) => {
    childrenMap.set(
      key,
      [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    );
  });

  return childrenMap;
};

// Resolve a node's axis ("h" or "v") and aligned flag from its override + inherited values
const resolveAxisAligned = (
  ov: string | null,
  inheritedAxis: "h" | "v",
  inheritedAligned: boolean,
): { axis: "h" | "v"; aligned: boolean } => {
  let axis = inheritedAxis;
  let aligned = inheritedAligned;
  if (ov === "right-aligned" || ov === "left-aligned") { axis = "h"; aligned = true; }
  else if (ov === "right" || ov === "left" || ov === "balanced") { axis = "h"; aligned = false; }
  else if (ov === "down-aligned" || ov === "up-aligned") { axis = "v"; aligned = true; }
  else if (ov === "down" || ov === "up") { axis = "v"; aligned = false; }
  return { axis, aligned };
};

// Unified subtree-height with cross-axis support
const buildSubtreeHeight = (
  nodeId: string,
  childrenMap: Map<string | null, MindmapNode[]>,
  nodeMap: Map<string, MindmapNode>,
  collapsedNodeIds: Set<string>,
  inheritedAxis: "h" | "v",
  inheritedAligned: boolean,
): number => {
  if (collapsedNodeIds.has(nodeId)) return NODE_HEIGHT;
  const node = nodeMap.get(nodeId);
  const { axis, aligned } = resolveAxisAligned(node?.nodeLayout ?? null, inheritedAxis, inheritedAligned);
  const children = childrenMap.get(nodeId) || [];
  if (children.length === 0) return NODE_HEIGHT;
  const childHeights = children.map((c) =>
    buildSubtreeHeight(c.id, childrenMap, nodeMap, collapsedNodeIds, axis, aligned),
  );
  const vGap = dynamicVGap(children.length);
  if (axis === "v") {
    // Vertical: children side by side → height = node + gap + deepest child
    return NODE_HEIGHT + dynamicVLevelGap(children.length) + Math.max(...childHeights);
  }
  // Horizontal: children stacked vertically
  const childrenTotal = childHeights.reduce((s, h) => s + h, 0) + vGap * (children.length - 1);
  // Cross-axis switch (v→h): force edge-aligned height so children don't extend above the node
  const forceEdge = axis !== inheritedAxis;
  return (aligned || forceEdge) ? NODE_HEIGHT + vGap + childrenTotal : childrenTotal;
};

const computeGroupHeight = (
  nodes: MindmapNode[],
  childrenMap: Map<string | null, MindmapNode[]>,
  nodeMap: Map<string, MindmapNode>,
  collapsedNodeIds: Set<string>,
  inheritedAxis: "h" | "v",
  inheritedAligned: boolean,
): number => {
  if (nodes.length === 0) return 0;
  const heights = nodes.map((n) =>
    buildSubtreeHeight(n.id, childrenMap, nodeMap, collapsedNodeIds, inheritedAxis, inheritedAligned),
  );
  return heights.reduce((s, h) => s + h, 0) + dynamicVGap(nodes.length) * (nodes.length - 1);
};

// Unified subtree-width with cross-axis support
const buildSubtreeWidth = (
  nodeId: string,
  childrenMap: Map<string | null, MindmapNode[]>,
  nodeMap: Map<string, MindmapNode>,
  collapsedNodeIds: Set<string>,
  inheritedAxis: "h" | "v",
  inheritedAligned: boolean,
): number => {
  if (collapsedNodeIds.has(nodeId)) return NODE_WIDTH;
  const node = nodeMap.get(nodeId);
  const { axis, aligned } = resolveAxisAligned(node?.nodeLayout ?? null, inheritedAxis, inheritedAligned);
  const children = childrenMap.get(nodeId) || [];
  if (children.length === 0) return NODE_WIDTH;
  const widths = children.map((c) =>
    buildSubtreeWidth(c.id, childrenMap, nodeMap, collapsedNodeIds, axis, aligned),
  );
  if (axis === "h") {
    // Horizontal: children stacked vertically → width = node + gap + widest child
    // Only count cross-axis children for width-proportional gap bonus
    const maxCrossAxisW = Math.max(NODE_WIDTH, ...children.map((c, i) => {
      const cn = nodeMap.get(c.id);
      const { axis: ca } = resolveAxisAligned(cn?.nodeLayout ?? null, axis, aligned);
      return ca !== axis ? widths[i] : NODE_WIDTH;
    }));
    const gap = dynamicBetweenGap(children.length, aligned, maxCrossAxisW);
    return NODE_WIDTH + gap + Math.max(...widths);
  }
  // Vertical: children spread horizontally
  const childrenTotal = widths.reduce((s, w) => s + w, 0) + dynamicHNodeGap(children.length) * (children.length - 1);
  return Math.max(NODE_WIDTH, childrenTotal);
};

const computeGroupWidth = (
  nodes: MindmapNode[],
  childrenMap: Map<string | null, MindmapNode[]>,
  nodeMap: Map<string, MindmapNode>,
  collapsedNodeIds: Set<string>,
  inheritedAxis: "h" | "v",
  inheritedAligned: boolean,
): number => {
  if (nodes.length === 0) return 0;
  const widths = nodes.map((n) =>
    buildSubtreeWidth(n.id, childrenMap, nodeMap, collapsedNodeIds, inheritedAxis, inheritedAligned),
  );
  return widths.reduce((s, w) => s + w, 0) + dynamicHNodeGap(nodes.length) * (nodes.length - 1);
};

/** Widest subtree width among children whose layout axis differs from parentAxis.
 *  Used to compute the width-proportional gap bonus in dynamicBetweenGap. */
const maxCrossAxisChildWidth = (
  children: MindmapNode[],
  parentAxis: "h" | "v",
  aligned: boolean,
  childrenMap: Map<string | null, MindmapNode[]>,
  nodeMap: Map<string, MindmapNode>,
  collapsedNodeIds: Set<string>,
): number => {
  if (children.length === 0) return NODE_WIDTH;
  return Math.max(NODE_WIDTH, ...children.map((c) => {
    const cn = nodeMap.get(c.id);
    const { axis: ca } = resolveAxisAligned(cn?.nodeLayout ?? null, parentAxis, aligned);
    return ca !== parentAxis ? buildSubtreeWidth(c.id, childrenMap, nodeMap, collapsedNodeIds, parentAxis, aligned) : NODE_WIDTH;
  }));
};

const isAlignedMode = (m: string) => m === "right-aligned" || m === "left-aligned" || m === "down-aligned" || m === "up-aligned";

const isVerticalOv = (ov: string | null): boolean =>
  ov === "down" || ov === "up" || ov === "down-aligned" || ov === "up-aligned";

const isHorizontalOv = (ov: string | null): boolean =>
  ov === "right" || ov === "left" || ov === "balanced"
  || ov === "right-aligned" || ov === "left-aligned";

const layoutNodesHorizontal = (
  nodes: MindmapNode[],
  roots: MindmapNode[],
  collapsedNodeIds: Set<string>,
  layoutMode: "balanced" | "right" | "left" | "right-aligned" | "left-aligned",
): PositionedNode[] => {
  const childrenMap = groupByParent(nodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const positioned = new Map<string, PositionedNode>();

  const heightFn = (id: string, aligned: boolean) =>
    buildSubtreeHeight(id, childrenMap, nodeMap, collapsedNodeIds, "h", aligned);

  const groupHeightFn = (group: MindmapNode[], aligned: boolean) =>
    computeGroupHeight(group, childrenMap, nodeMap, collapsedNodeIds, "h", aligned);

  const vWidthFn = (id: string, aligned: boolean) =>
    buildSubtreeWidth(id, childrenMap, nodeMap, collapsedNodeIds, "v", aligned);

  roots.forEach((root, rootIdx) => {
    const rootLayoutX = root.x ?? rootIdx * 800;
    const rootLayoutY = root.y ?? 200;

    const rootChildren = childrenMap.get(root.id) || [];

    let rightChildren: MindmapNode[];
    let leftChildren: MindmapNode[];

    const effectiveLayout = root.nodeLayout ?? layoutMode;
    const rootAligned = isAlignedMode(effectiveLayout);

    if (effectiveLayout === "balanced" && rootChildren.length > 0) {
      const rightCount = Math.ceil(rootChildren.length / 2);
      rightChildren = rootChildren.slice(0, rightCount);
      leftChildren = rootChildren.slice(rightCount);
    } else if (effectiveLayout === "left" || effectiveLayout === "left-aligned") {
      rightChildren = [];
      leftChildren = rootChildren;
    } else {
      rightChildren = rootChildren;
      leftChildren = [];
    }

    positioned.set(root.id, {
      node: root,
      x: rootLayoutX,
      y: rootLayoutY,
      width: ROOT_NODE_WIDTH,
      height: ROOT_NODE_HEIGHT,
      direction: "root",
    });

    // Use function declarations so placeHSubtree ↔ placeVSubtree can mutually recurse.
    // betweenGap / levelGap: gap from parent to this node, computed by the parent so all siblings share the same value.
    function placeHSubtree(nodeId: string, topAbsolute: number, dir: "left" | "right", parentX: number, parentWidth: number, aligned: boolean, betweenGap: number): number {
      const node = nodeMap.get(nodeId);
      if (!node) return 0;

      const parentAligned = aligned;
      const parentDir = dir;
      const nodeOverride = node.nodeLayout ?? null;

      // ── Cross-axis switch: horizontal → vertical ──
      if (isVerticalOv(nodeOverride)) {
        const vDir: "down" | "up" = (nodeOverride === "down" || nodeOverride === "down-aligned") ? "down" : "up";
        const vAligned = nodeOverride === "down-aligned" || nodeOverride === "up-aligned";

        const subtreeH = buildSubtreeHeight(nodeId, childrenMap, nodeMap, collapsedNodeIds, "h", aligned);
        const x = dir === "right"
          ? parentX + parentWidth + betweenGap
          : parentX - betweenGap - NODE_WIDTH;
        const y = vDir === "down"
          ? topAbsolute
          : topAbsolute + subtreeH - NODE_HEIGHT;

        positioned.set(nodeId, {
          node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
          direction: vDir, aligned: vAligned,
          parentAligned, parentDirection: parentDir,
        });

        if (!collapsedNodeIds.has(nodeId)) {
          const children = childrenMap.get(nodeId) || [];
          if (children.length > 0) {
            const hNodeGap = dynamicHNodeGap(children.length);
            const childLevelGap = dynamicVLevelGap(children.length);
            const childWidths = children.map((c) => vWidthFn(c.id, vAligned));
            const totalChildW = childWidths.reduce((s, w) => s + w, 0) + hNodeGap * (children.length - 1);
            let cx = vAligned ? x : x + NODE_WIDTH / 2 - totalChildW / 2;
            children.forEach((child, i) => {
              placeVSubtree(child.id, cx, y, NODE_HEIGHT, vDir, vAligned, childLevelGap);
              cx += childWidths[i] + hNodeGap;
            });
          }
        }
        return subtreeH;
      }

      // ── Normal horizontal placement ──
      let localAligned = aligned;
      let localDir = dir;
      if (nodeOverride === "right-aligned") { localAligned = true; localDir = "right"; }
      else if (nodeOverride === "left-aligned") { localAligned = true; localDir = "left"; }
      else if (nodeOverride === "right") { localAligned = false; localDir = "right"; }
      else if (nodeOverride === "left") { localAligned = false; localDir = "left"; }

      const subtreeH = heightFn(nodeId, localAligned);
      const y = localAligned
        ? topAbsolute
        : topAbsolute + subtreeH / 2 - NODE_HEIGHT / 2;

      const x =
        localDir === "right"
          ? parentX + parentWidth + betweenGap
          : parentX - betweenGap - NODE_WIDTH;

      positioned.set(nodeId, { node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, direction: localDir, aligned: localAligned, parentAligned, parentDirection: parentDir });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        const vGap = dynamicVGap(children.length);
        const childGap = dynamicBetweenGap(children.length, localAligned,
          maxCrossAxisChildWidth(children, "h", localAligned, childrenMap, nodeMap, collapsedNodeIds));

        if (nodeOverride === "balanced" && children.length > 0) {
          const rightCount = Math.ceil(children.length / 2);
          const rightKids = children.slice(0, rightCount);
          const leftKids = children.slice(rightCount);
          const rightGroupH = groupHeightFn(rightKids, localAligned);
          let cursor = localAligned
            ? topAbsolute + NODE_HEIGHT + vGap
            : topAbsolute + subtreeH / 2 - rightGroupH / 2;
          rightKids.forEach((child) => {
            const h = placeHSubtree(child.id, cursor, "right", x, NODE_WIDTH, localAligned, childGap);
            cursor += h + vGap;
          });
          const leftGroupH = groupHeightFn(leftKids, localAligned);
          cursor = localAligned
            ? topAbsolute + NODE_HEIGHT + vGap + rightGroupH + (rightKids.length > 0 ? vGap : 0)
            : topAbsolute + subtreeH / 2 - leftGroupH / 2;
          leftKids.forEach((child) => {
            const h = placeHSubtree(child.id, cursor, "left", x, NODE_WIDTH, localAligned, childGap);
            cursor += h + vGap;
          });
        } else {
          const childDir: "left" | "right" =
            nodeOverride === "right" || nodeOverride === "right-aligned" ? "right"
            : nodeOverride === "left" || nodeOverride === "left-aligned" ? "left"
            : localDir;
          const childAligned = isAlignedMode(nodeOverride ?? "") ? true : localAligned;
          let cursor = localAligned ? topAbsolute + NODE_HEIGHT + vGap : topAbsolute;
          children.forEach((child) => {
            const h = placeHSubtree(child.id, cursor, childDir, x, NODE_WIDTH, childAligned, childGap);
            cursor += h + vGap;
          });
        }
      }

      return subtreeH;
    }

    // Place a node in vertical mode (used when cross-axis switch from horizontal → vertical)
    function placeVSubtree(nodeId: string, leftEdge: number, parentY: number, parentHeight: number, vDir: "down" | "up", aligned: boolean, levelGap: number): void {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const parentAligned = aligned;
      const nodeOverride = node.nodeLayout ?? null;

      if (isHorizontalOv(nodeOverride)) {
        const hDir: "left" | "right" = (nodeOverride === "left" || nodeOverride === "left-aligned") ? "left" : "right";
        const hAligned = isAlignedMode(nodeOverride!);

        const sw = vWidthFn(nodeId, aligned);
        // For "up", use full subtreeH so horizontal children don't overflow downward
        const nodeSubtreeH = buildSubtreeHeight(nodeId, childrenMap, nodeMap, collapsedNodeIds, "v", aligned);
        const x = hDir === "right" ? leftEdge : leftEdge + sw - NODE_WIDTH;
        const y = vDir === "down"
          ? parentY + parentHeight + levelGap
          : parentY - levelGap - nodeSubtreeH;

        positioned.set(nodeId, {
          node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
          direction: hDir, aligned: hAligned,
          parentAligned, parentDirection: vDir,
        });

        if (!collapsedNodeIds.has(nodeId)) {
          const children = childrenMap.get(nodeId) || [];
          if (children.length > 0) {
            const chHeights = children.map((c) =>
              buildSubtreeHeight(c.id, childrenMap, nodeMap, collapsedNodeIds, "h", hAligned));
            const chVGap = dynamicVGap(children.length);
            const chBetweenGap = dynamicBetweenGap(children.length, hAligned);
            let cursor = y + NODE_HEIGHT + chVGap;
            children.forEach((child) => {
              const h = placeHSubtree(child.id, cursor, hDir, x, NODE_WIDTH, hAligned, chBetweenGap);
              cursor += h + chVGap;
            });
          }
        }
        return;
      }

      // Normal vertical placement
      let localAligned = aligned;
      let localDir = vDir;
      if (nodeOverride === "down-aligned") { localAligned = true; localDir = "down"; }
      else if (nodeOverride === "up-aligned") { localAligned = true; localDir = "up"; }
      else if (nodeOverride === "down") { localAligned = false; localDir = "down"; }
      else if (nodeOverride === "up") { localAligned = false; localDir = "up"; }

      const sw = vWidthFn(nodeId, localAligned);
      const x = localAligned ? leftEdge : leftEdge + sw / 2 - NODE_WIDTH / 2;
      const y = vDir === "down"
        ? parentY + parentHeight + levelGap
        : parentY - levelGap - NODE_HEIGHT;

      positioned.set(nodeId, {
        node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
        direction: localDir, aligned: localAligned,
        parentAligned, parentDirection: vDir,
      });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        const hNodeGap = dynamicHNodeGap(children.length);
        const childLevelGap = dynamicVLevelGap(children.length);
        const childWidths = children.map((c) => vWidthFn(c.id, localAligned));
        let csr = leftEdge;
        children.forEach((child, i) => {
          placeVSubtree(child.id, csr, y, NODE_HEIGHT, localDir, localAligned, childLevelGap);
          csr += childWidths[i] + hNodeGap;
        });
      }
    }

    const rootChildCount = rightChildren.length + leftChildren.length;
    const rootVGap = dynamicVGap(rootChildCount);
    const rootBetweenGap = dynamicBetweenGap(rootChildCount, rootAligned,
      maxCrossAxisChildWidth(rootChildren, "h", rootAligned, childrenMap, nodeMap, collapsedNodeIds));
    const rightGroupH = groupHeightFn(rightChildren, rootAligned);
    let cursor = rootAligned
      ? rootLayoutY + ROOT_NODE_HEIGHT + rootVGap
      : rootLayoutY + ROOT_NODE_HEIGHT / 2 - rightGroupH / 2;
    rightChildren.forEach((child) => {
      const h = placeHSubtree(child.id, cursor, "right", rootLayoutX, ROOT_NODE_WIDTH, rootAligned, rootBetweenGap);
      cursor += h + rootVGap;
    });

    const leftGroupH = groupHeightFn(leftChildren, rootAligned);
    if (!rootAligned) {
      cursor = rootLayoutY + ROOT_NODE_HEIGHT / 2 - leftGroupH / 2;
    }
    // If rootAligned, cursor already continues from right children
    leftChildren.forEach((child) => {
      const h = placeHSubtree(child.id, cursor, "left", rootLayoutX, ROOT_NODE_WIDTH, rootAligned, rootBetweenGap);
      cursor += h + rootVGap;
    });
  });

  return Array.from(positioned.values());
};

const isAlignedVertical = (m: string) => m === "down-aligned" || m === "up-aligned";

const layoutNodesVertical = (
  nodes: MindmapNode[],
  roots: MindmapNode[],
  collapsedNodeIds: Set<string>,
  mode: "down" | "up" | "down-aligned" | "up-aligned",
): PositionedNode[] => {
  const childrenMap = groupByParent(nodes);
  const positioned = new Map<string, PositionedNode>();
  const baseDir: "down" | "up" = mode === "down" || mode === "down-aligned" ? "down" : "up";
  const rootAligned = isAlignedVertical(mode);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const widthFn = (id: string, aligned: boolean) =>
    buildSubtreeWidth(id, childrenMap, nodeMap, collapsedNodeIds, "v", aligned);

  const groupWidthFn = (group: MindmapNode[], aligned: boolean) =>
    computeGroupWidth(group, childrenMap, nodeMap, collapsedNodeIds, "v", aligned);

  const hHeightFn = (id: string, aligned: boolean) =>
    buildSubtreeHeight(id, childrenMap, nodeMap, collapsedNodeIds, "h", aligned);

  roots.forEach((root, rootIdx) => {
    const rootLayoutX = root.x ?? rootIdx * 800;
    const rootLayoutY = root.y ?? 200;

    const rootChildren = childrenMap.get(root.id) || [];
    const totalChildrenWidth = groupWidthFn(rootChildren, rootAligned);
    const childrenStartX = rootAligned
      ? rootLayoutX
      : rootChildren.length > 0
        ? rootLayoutX + ROOT_NODE_WIDTH / 2 - totalChildrenWidth / 2
        : rootLayoutX;

    positioned.set(root.id, {
      node: root,
      x: rootLayoutX,
      y: rootLayoutY,
      width: ROOT_NODE_WIDTH,
      height: ROOT_NODE_HEIGHT,
      direction: "root",
    });

    function placeVSubtree(nodeId: string, leftEdge: number, parentY: number, parentHeight: number, vDir: "down" | "up", aligned: boolean, levelGap: number): void {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const parentAligned = aligned;
      const nodeOverride = node.nodeLayout ?? null;

      // ── Cross-axis switch: vertical → horizontal ──
      if (isHorizontalOv(nodeOverride)) {
        const hDir: "left" | "right" = (nodeOverride === "left" || nodeOverride === "left-aligned") ? "left" : "right";
        const hAligned = isAlignedMode(nodeOverride!);

        const sw = widthFn(nodeId, aligned);
        // For "up", use full subtreeH so horizontal children don't overflow downward
        const nodeSubtreeH = buildSubtreeHeight(nodeId, childrenMap, nodeMap, collapsedNodeIds, "v", aligned);
        const x = hDir === "right" ? leftEdge : leftEdge + sw - NODE_WIDTH;
        const y = vDir === "down"
          ? parentY + parentHeight + levelGap
          : parentY - levelGap - nodeSubtreeH;

        positioned.set(nodeId, {
          node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
          direction: hDir, aligned: hAligned,
          parentAligned, parentDirection: vDir,
        });

        if (!collapsedNodeIds.has(nodeId)) {
          const children = childrenMap.get(nodeId) || [];
          if (children.length > 0) {
            const chHeights = children.map((c) => hHeightFn(c.id, hAligned));
            const chVGap = dynamicVGap(children.length);
            const chBetweenGap = dynamicBetweenGap(children.length, hAligned);
            let hCursor = y + NODE_HEIGHT + chVGap;
            children.forEach((child) => {
              const h = placeHSubtree(child.id, hCursor, hDir, x, NODE_WIDTH, hAligned, chBetweenGap);
              hCursor += h + chVGap;
            });
          }
        }
        return;
      }

      // ── Normal vertical placement ──
      let localAligned = aligned;
      let localDir = vDir;
      if (nodeOverride === "down-aligned") { localAligned = true; localDir = "down"; }
      else if (nodeOverride === "up-aligned") { localAligned = true; localDir = "up"; }
      else if (nodeOverride === "down") { localAligned = false; localDir = "down"; }
      else if (nodeOverride === "up") { localAligned = false; localDir = "up"; }

      const sw = widthFn(nodeId, localAligned);
      const x = localAligned ? leftEdge : leftEdge + sw / 2 - NODE_WIDTH / 2;
      const y = vDir === "down"
        ? parentY + parentHeight + levelGap
        : parentY - levelGap - NODE_HEIGHT;

      positioned.set(nodeId, { node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, direction: localDir, aligned: localAligned, parentAligned, parentDirection: vDir });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        const hNodeGap = dynamicHNodeGap(children.length);
        const childLevelGap = dynamicVLevelGap(children.length);
        let cursor = leftEdge;
        children.forEach((child) => {
          const childW = widthFn(child.id, localAligned);
          placeVSubtree(child.id, cursor, y, NODE_HEIGHT, localDir, localAligned, childLevelGap);
          cursor += childW + hNodeGap;
        });
      }
    }

    // Horizontal placement for cross-axis switch inside vertical tree
    function placeHSubtree(nodeId: string, topAbsolute: number, dir: "left" | "right", parentX: number, parentWidth: number, aligned: boolean, betweenGap: number): number {
      const node = nodeMap.get(nodeId);
      if (!node) return 0;

      const parentAligned = aligned;
      const parentDir = dir;
      const nodeOverride = node.nodeLayout ?? null;

      if (isVerticalOv(nodeOverride)) {
        const vDir: "down" | "up" = (nodeOverride === "down" || nodeOverride === "down-aligned") ? "down" : "up";
        const vAligned = nodeOverride === "down-aligned" || nodeOverride === "up-aligned";
        const subtreeH = buildSubtreeHeight(nodeId, childrenMap, nodeMap, collapsedNodeIds, "h", aligned);
        const x = dir === "right"
          ? parentX + parentWidth + betweenGap
          : parentX - betweenGap - NODE_WIDTH;
        const y = vDir === "down"
          ? topAbsolute
          : topAbsolute + subtreeH - NODE_HEIGHT;

        positioned.set(nodeId, {
          node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT,
          direction: vDir, aligned: vAligned,
          parentAligned, parentDirection: parentDir,
        });

        if (!collapsedNodeIds.has(nodeId)) {
          const children = childrenMap.get(nodeId) || [];
          if (children.length > 0) {
            const hNodeGap = dynamicHNodeGap(children.length);
            const childLevelGap = dynamicVLevelGap(children.length);
            const childWidths = children.map((c) => widthFn(c.id, vAligned));
            const totalChildW = childWidths.reduce((s, w) => s + w, 0) + hNodeGap * (children.length - 1);
            let cx = vAligned ? x : x + NODE_WIDTH / 2 - totalChildW / 2;
            children.forEach((child, i) => {
              placeVSubtree(child.id, cx, y, NODE_HEIGHT, vDir, vAligned, childLevelGap);
              cx += childWidths[i] + hNodeGap;
            });
          }
        }
        return subtreeH;
      }

      // Normal horizontal placement
      let localAligned = aligned;
      let localDir = dir;
      if (nodeOverride === "right-aligned") { localAligned = true; localDir = "right"; }
      else if (nodeOverride === "left-aligned") { localAligned = true; localDir = "left"; }
      else if (nodeOverride === "right") { localAligned = false; localDir = "right"; }
      else if (nodeOverride === "left") { localAligned = false; localDir = "left"; }

      const subtreeH = hHeightFn(nodeId, localAligned);
      const y = localAligned
        ? topAbsolute
        : topAbsolute + subtreeH / 2 - NODE_HEIGHT / 2;
      const x = localDir === "right"
        ? parentX + parentWidth + betweenGap
        : parentX - betweenGap - NODE_WIDTH;

      positioned.set(nodeId, { node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, direction: localDir, aligned: localAligned, parentAligned, parentDirection: parentDir });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        const vGap = dynamicVGap(children.length);
        const childGap = dynamicBetweenGap(children.length, localAligned,
          maxCrossAxisChildWidth(children, "h", localAligned, childrenMap, nodeMap, collapsedNodeIds));
        const childDir: "left" | "right" =
          nodeOverride === "right" || nodeOverride === "right-aligned" ? "right"
          : nodeOverride === "left" || nodeOverride === "left-aligned" ? "left"
          : localDir;
        const childAligned = isAlignedMode(nodeOverride ?? "") ? true : localAligned;
        let hCursor = localAligned ? topAbsolute + NODE_HEIGHT + vGap : topAbsolute;
        children.forEach((child) => {
          const h = placeHSubtree(child.id, hCursor, childDir, x, NODE_WIDTH, childAligned, childGap);
          hCursor += h + vGap;
        });
      }

      return subtreeH;
    }

    const rootHNodeGap = dynamicHNodeGap(rootChildren.length);
    const rootLevelGap = dynamicVLevelGap(rootChildren.length);
    let cursor = childrenStartX;
    rootChildren.forEach((child) => {
      const childW = widthFn(child.id, rootAligned);
      placeVSubtree(child.id, cursor, rootLayoutY, ROOT_NODE_HEIGHT, baseDir, rootAligned, rootLevelGap);
      cursor += childW + rootHNodeGap;
    });
  });

  return Array.from(positioned.values());
};

const layoutNodes = (
  nodes: MindmapNode[],
  collapsedNodeIds: Set<string>,
  layoutMode: LayoutMode = "balanced",
): PositionedNode[] => {
  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length === 0) return [];

  const results: PositionedNode[] = [];
  for (const root of roots) {
    const effective = root.nodeLayout ?? layoutMode;
    if (effective === "down" || effective === "up" || effective === "down-aligned" || effective === "up-aligned") {
      results.push(...layoutNodesVertical(nodes, [root], collapsedNodeIds, effective));
    } else {
      results.push(...layoutNodesHorizontal(nodes, [root], collapsedNodeIds, effective as "balanced" | "right" | "left" | "right-aligned" | "left-aligned"));
    }
  }
  return results;
};

const buildBranchColorMap = (nodes: MindmapNode[]): Map<string, number> => {
  const map = new Map<string, number>();
  const childrenMap = groupByParent(nodes);
  const roots = nodes.filter((n) => n.parentId === null);
  let colorIdx = 0;

  roots.forEach((root) => {
    const rootChildren = childrenMap.get(root.id) || [];
    rootChildren.forEach((child) => {
      const branchIdx = colorIdx++ % 10;
      const assignBranch = (id: string) => {
        map.set(id, branchIdx);
        (childrenMap.get(id) || []).forEach((c) => assignBranch(c.id));
      };
      assignBranch(child.id);
    });
  });

  return map;
};

const buildEdgePathCurve = (
  x1: number, y1: number, x2: number, y2: number,
  direction: PositionedNode["direction"],
): string => {
  if (direction === "down") {
    const dy = Math.abs(y2 - y1);
    const cp = Math.max(20, dy * 0.4);
    return `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
  }
  if (direction === "up") {
    const dy = Math.abs(y2 - y1);
    const cp = Math.max(20, dy * 0.4);
    return `M ${x1} ${y1} C ${x1} ${y1 - cp}, ${x2} ${y2 + cp}, ${x2} ${y2}`;
  }
  if (direction === "left") {
    const dx = Math.abs(x2 - x1);
    const cp = Math.max(20, dx * 0.4);
    return `M ${x1} ${y1} C ${x1 - cp} ${y1}, ${x2 + cp} ${y2}, ${x2} ${y2}`;
  }
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(20, dx * 0.4);
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
};

const buildEdgePathStraight = (
  x1: number, y1: number, x2: number, y2: number,
): string => `M ${x1} ${y1} L ${x2} ${y2}`;

const buildEdgePathOrthogonal = (
  x1: number, y1: number, x2: number, y2: number,
  direction: PositionedNode["direction"],
): string => {
  const isVertical = direction === "down" || direction === "up";
  if (isVertical) {
    if (Math.abs(x2 - x1) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`;
  }
  if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
};

const buildEdgePathRounded = (
  x1: number, y1: number, x2: number, y2: number,
  direction: PositionedNode["direction"],
): string => {
  const isVertical = direction === "down" || direction === "up";
  if (isVertical) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    if (dx < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const r = Math.min(8, dx / 2, dy / 2);
    if (r < 1) return buildEdgePathOrthogonal(x1, y1, x2, y2, direction);
    const midY = (y1 + y2) / 2;
    const sx = x2 > x1 ? 1 : -1;
    const sy = y2 > y1 ? 1 : -1;
    return `M ${x1} ${y1} V ${midY - r * sy} Q ${x1} ${midY} ${x1 + r * sx} ${midY} H ${x2 - r * sx} Q ${x2} ${midY} ${x2} ${midY + r * sy} V ${y2}`;
  }
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dy < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const r = Math.min(8, dx / 2, dy / 2);
  if (r < 1) return buildEdgePathOrthogonal(x1, y1, x2, y2, direction);
  const midX = (x1 + x2) / 2;
  const sx = x2 > x1 ? 1 : -1;
  const sy = y2 > y1 ? 1 : -1;
  return `M ${x1} ${y1} H ${midX - r * sx} Q ${midX} ${y1} ${midX} ${y1 + r * sy} V ${y2 - r * sy} Q ${midX} ${y2} ${midX + r * sx} ${y2} H ${x2}`;
};

/** Tree-chart trunk edge: trunk close to parent, branches to children with rounded corners. */
const buildEdgePathTree = (
  x1: number, y1: number, x2: number, y2: number,
  direction: PositionedNode["direction"],
  bottomStart = false,
): string => {
  const dy = y2 - y1;
  const dx = x2 - x1;
  if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return `M ${x1} ${y1}`;

  // Bottom-start horizontal tree: V down from parent bottom, turn, H to child
  if (bottomStart) {
    const r = Math.min(6, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = dx > 0 ? 1 : -1;
    if (r < 1) {
      return `M ${x1} ${y1} V ${y2} H ${x2}`;
    }
    return [
      `M ${x1} ${y1}`,
      `V ${y2 - r}`,
      `Q ${x1} ${y2} ${x1 + r * sx} ${y2}`,
      `H ${x2}`,
    ].join(" ");
  }

  const isVertical = direction === "down" || direction === "up";

  if (isVertical) {
    // Horizontal trunk: M x1,y1 → V trunkY → H x2 → V y2
    const trunkY = y1 + dy / 3;
    const r = Math.min(6, Math.abs(dx) / 2, Math.abs(dy) / 6);
    if (r < 1 || Math.abs(dx) < 1) {
      return `M ${x1} ${y1} V ${trunkY} H ${x2} V ${y2}`;
    }
    const sy = dy > 0 ? 1 : -1;
    const sx = dx > 0 ? 1 : -1;
    return [
      `M ${x1} ${y1}`,
      `V ${trunkY - r * sy}`,
      `Q ${x1} ${trunkY} ${x1 + r * sx} ${trunkY}`,
      `H ${x2 - r * sx}`,
      `Q ${x2} ${trunkY} ${x2} ${trunkY + r * sy}`,
      `V ${y2}`,
    ].join(" ");
  }

  // Horizontal: vertical trunk: M x1,y1 → H trunkX → V y2 → H x2
  const trunkX = x1 + dx / 3;
  const r = Math.min(6, Math.abs(dy) / 2, Math.abs(dx) / 6);
  if (r < 1 || Math.abs(dy) < 1) {
    return `M ${x1} ${y1} H ${trunkX} V ${y2} H ${x2}`;
  }
  const sy = dy > 0 ? 1 : -1;
  const sx = dx > 0 ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `H ${trunkX - r * sx}`,
    `Q ${trunkX} ${y1} ${trunkX} ${y1 + r * sy}`,
    `V ${y2 - r * sy}`,
    `Q ${trunkX} ${y2} ${trunkX + r * sx} ${y2}`,
    `H ${x2}`,
  ].join(" ");
};

const buildEdgePath = (
  x1: number, y1: number, x2: number, y2: number,
  direction: PositionedNode["direction"],
  style: EdgeStyle = "curve",
  treeMode = false,
  bottomStart = false,
): string => {
  if (treeMode) return buildEdgePathTree(x1, y1, x2, y2, direction, bottomStart);
  switch (style) {
    case "straight": return buildEdgePathStraight(x1, y1, x2, y2);
    case "orthogonal": return buildEdgePathOrthogonal(x1, y1, x2, y2, direction);
    case "rounded": return buildEdgePathRounded(x1, y1, x2, y2, direction);
    default: return buildEdgePathCurve(x1, y1, x2, y2, direction);
  }
};

const clampScale = (nextScale: number): number => Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));

const getSiblingDropIndex = (siblings: PositionedNode[], pointerY: number): number => {
  let index = 0;

  siblings.forEach((sibling) => {
    const centerY = sibling.y + sibling.height / 2;
    if (pointerY > centerY) {
      index += 1;
    }
  });

  return index;
};

const getHiddenByCollapse = (nodes: MindmapNode[], collapsedNodeIds: Set<string>): Set<string> => {
  const hidden = new Set<string>();
  if (collapsedNodeIds.size === 0) {
    return hidden;
  }

  const childrenMap = groupByParent(nodes);
  const stack = Array.from(collapsedNodeIds);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const children = childrenMap.get(current) || [];
    children.forEach((child) => {
      if (!hidden.has(child.id)) {
        hidden.add(child.id);
        stack.push(child.id);
      }
    });
  }

  return hidden;
};

export function MindmapCanvas({
  nodes,
  selectedNodeIds,
  collapsedNodeIds,
  editable,
  layoutMode,
  showWbsNumbers = false,
  onSelectNode,
  onToggleNodeSelection,
  onSelectNodes,
  onRenameNode,
  onToggleCollapse,
  onMoveNode,
  onMoveRootNode,
  onAddRootNode,
}: MindmapCanvasProps) {
  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const collapsedSet = useMemo(() => new Set(collapsedNodeIds), [collapsedNodeIds]);
  const hiddenSet = useMemo(() => getHiddenByCollapse(nodes, collapsedSet), [nodes, collapsedSet]);
  const visibleNodes = useMemo(() => nodes.filter((node) => !hiddenSet.has(node.id)), [nodes, hiddenSet]);
  // WBS numbers computed from full node list (not just visible) so numbering stays stable when nodes are collapsed
  const wbsNumbers = useMemo(() => (showWbsNumbers ? computeWbsNumbers(nodes) : EMPTY_WBS_MAP), [nodes, showWbsNumbers]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 48, y: 48 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragging, setDragging] = useState<DraggingState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [rootDragging, setRootDragging] = useState<RootDraggingState | null>(null);
  const [rootDragOffset, setRootDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [reparentTarget, setReparentTarget] = useState<{
    targetNodeId: string;
    pointerLayoutX: number;
    pointerLayoutY: number;
  } | null>(null);
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  const scaleRef = useRef(1);
  const panRef = useRef({ x: 48, y: 48 });
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const offsetRef = useRef({ x: CANVAS_PAD, y: CANVAS_PAD });
  const rootDraggingRef = useRef(false);
  const panMovedRef = useRef(false);
  const dragDescendantsRef = useRef<Set<string> | null>(null);

  const nodesForLayout = useMemo(() => {
    if (rootDragging && rootDragOffset) {
      return visibleNodes.map((n) =>
        n.id === rootDragging.nodeId
          ? { ...n, x: rootDragging.startLayoutX + rootDragOffset.x, y: rootDragging.startLayoutY + rootDragOffset.y }
          : n,
      );
    }
    return visibleNodes;
  }, [visibleNodes, rootDragging, rootDragOffset]);

  const positioned = useMemo(
    () => layoutNodes(nodesForLayout, collapsedSet, layoutMode),
    [nodesForLayout, collapsedSet, layoutMode],
  );

  const branchColorMap = useMemo(() => buildBranchColorMap(nodes), [nodes]);

  const byId = useMemo(() => new Map(positioned.map((item) => [item.node.id, item])), [positioned]);

  const minX = positioned.length ? Math.min(...positioned.map((n) => n.x)) : 0;
  const minY = positioned.length ? Math.min(...positioned.map((n) => n.y)) : 0;
  const maxX = positioned.length ? Math.max(...positioned.map((n) => n.x + n.width)) : 0;
  const maxY = positioned.length ? Math.max(...positioned.map((n) => n.y + n.height)) : 0;

  const offsetX = Math.max(0, CANVAS_PAD - minX);
  const offsetY = Math.max(0, CANVAS_PAD - minY);
  const width = maxX + offsetX + CANVAS_PAD;
  const height = maxY + offsetY + CANVAS_PAD;

  // Update offsetRef synchronously during render for use in event handlers
  offsetRef.current = { x: offsetX, y: offsetY };

  const parentIdSet = useMemo(
    () => new Set(nodes.filter((n) => n.parentId !== null).map((n) => n.parentId!)),
    [nodes],
  );

  const positionedByParent = useMemo(() => {
    const map = new Map<string | null, PositionedNode[]>();
    positioned.forEach((item) => {
      const list = map.get(item.node.parentId) || [];
      list.push(item);
      map.set(item.node.parentId, list);
    });
    map.forEach((list, key) => {
      map.set(
        key,
        [...list].sort((a, b) => a.node.order - b.node.order || a.node.title.localeCompare(b.node.title)),
      );
    });
    return map;
  }, [positioned]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const fitToScreen = () => {
    const viewport = viewportRef.current;
    if (!viewport || width <= 0 || height <= 0) {
      return;
    }

    const safeScale = Math.min((viewport.clientWidth - 48) / width, (viewport.clientHeight - 48) / height, 1);
    const nextScale = clampScale(Number.isFinite(safeScale) ? safeScale : 1);
    const contentWidth = width * nextScale;
    const contentHeight = height * nextScale;

    const nextPan = {
      x: (viewport.clientWidth - contentWidth) / 2,
      y: (viewport.clientHeight - contentHeight) / 2,
    };

    scaleRef.current = nextScale;
    panRef.current = nextPan;
    setScale(nextScale);
    setPan(nextPan);
  };

  useEffect(() => {
    if (rootDraggingRef.current) return;
    fitToScreen();
  }, [width, height]);

  const zoomAtViewportPoint = (delta: number, anchorX: number, anchorY: number) => {
    if (!editable) {
      return;
    }

    const currentScale = scaleRef.current;
    const nextScale = clampScale(currentScale + delta);
    if (nextScale === currentScale) {
      return;
    }

    const currentPan = panRef.current;
    const contentX = (anchorX - currentPan.x) / currentScale;
    const contentY = (anchorY - currentPan.y) / currentScale;

    const nextPan = {
      x: anchorX - contentX * nextScale,
      y: anchorY - contentY * nextScale,
    };

    scaleRef.current = nextScale;
    panRef.current = nextPan;
    setPan(nextPan);
    setScale(nextScale);
  };

  const zoomByCenter = (delta: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    zoomAtViewportPoint(delta, viewport.clientWidth / 2, viewport.clientHeight / 2);
  };

  const zoomPercent = Math.round(scale * 100);

  const handleViewportWheel = (event: WheelEvent) => {
    if (!editable) {
      return;
    }

    event.preventDefault();
    const direction = event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    zoomAtViewportPoint(direction, anchorX, anchorY);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.addEventListener("wheel", handleViewportWheel, { passive: false });

    // Prevent touchmove default to stop page scroll/bounce on mobile
    const preventTouch = (e: TouchEvent) => { e.preventDefault(); };
    viewport.addEventListener("touchmove", preventTouch, { passive: false });

    return () => {
      viewport.removeEventListener("wheel", handleViewportWheel);
      viewport.removeEventListener("touchmove", preventTouch);
    };
  }, [editable]);

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) {
      return;
    }

    if (!viewportRef.current) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".map-node")) {
      return;
    }

    // Right-click (or ctrl+click) → pan
    // Touch on empty canvas → pan (no RMB on mobile)
    if (event.button === 2 || event.pointerType === "touch") {
      viewportRef.current.setPointerCapture(event.pointerId);
      setIsPanning(true);
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      panMovedRef.current = false;
      return;
    }

    if (event.button !== 0) {
      return;
    }

    // Left-click on empty canvas → marquee select
    viewportRef.current.setPointerCapture(event.pointerId);
    const rect = viewportRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setMarquee({ startX: x, startY: y, currentX: x, currentY: y });
  };

  const handleViewportDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editable) return;

    const target = event.target as HTMLElement;
    if (target.closest(".map-node")) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const layoutX =
      (event.clientX - rect.left - panRef.current.x) / scaleRef.current -
      offsetRef.current.x -
      ROOT_NODE_WIDTH / 2;
    const layoutY =
      (event.clientY - rect.top - panRef.current.y) / scaleRef.current -
      offsetRef.current.y -
      ROOT_NODE_HEIGHT / 2;
    onAddRootNode(layoutX, layoutY);
  };

  const startRename = (nodeId: string, currentTitle: string) => {
    if (!editable) {
      return;
    }

    setEditingNodeId(nodeId);
    setEditingTitle(currentTitle);
    onSelectNode(nodeId);
  };

  const finishRename = (options?: { cancel?: boolean }) => {
    if (!editingNodeId) {
      return;
    }

    const nodeId = editingNodeId;
    const nextTitle = editingTitle.trim();
    setEditingNodeId(null);

    if (options?.cancel || !nextTitle) {
      setEditingTitle("");
      return;
    }

    onRenameNode(nodeId, nextTitle);
    setEditingTitle("");
  };

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) {
      return;
    }

    if (marquee) {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) {
        setMarquee({
          ...marquee,
          currentX: event.clientX - rect.left,
          currentY: event.clientY - rect.top,
        });
      }
      return;
    }

    if (!isPanning || !lastPointerRef.current) {
      return;
    }

    const dx = event.clientX - lastPointerRef.current.x;
    const dy = event.clientY - lastPointerRef.current.y;

    const nextPan = {
      x: panRef.current.x + dx,
      y: panRef.current.y + dy,
    };

    panRef.current = nextPan;
    setPan(nextPan);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    panMovedRef.current = true;
  };

  const handleViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) {
      return;
    }

    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId);
    }

    if (marquee) {
      const dx = Math.abs(marquee.currentX - marquee.startX);
      const dy = Math.abs(marquee.currentY - marquee.startY);

      // Tiny drag = just a click on empty canvas → deselect
      if (dx < 4 && dy < 4) {
        onSelectNode(null);
        setMarquee(null);
        return;
      }

      const s = scaleRef.current;
      const p = panRef.current;
      const off = offsetRef.current;

      const toLayoutX = (vx: number) => (vx - p.x) / s - off.x;
      const toLayoutY = (vy: number) => (vy - p.y) / s - off.y;

      const lx1 = toLayoutX(Math.min(marquee.startX, marquee.currentX));
      const ly1 = toLayoutY(Math.min(marquee.startY, marquee.currentY));
      const lx2 = toLayoutX(Math.max(marquee.startX, marquee.currentX));
      const ly2 = toLayoutY(Math.max(marquee.startY, marquee.currentY));

      const selected = positioned.filter((pos) => {
        return pos.x < lx2 && pos.x + pos.width > lx1 && pos.y < ly2 && pos.y + pos.height > ly1;
      });

      if (selected.length > 0) {
        onSelectNodes(selected.map((p) => p.node.id));
      } else {
        onSelectNode(null);
      }
      setMarquee(null);
      return;
    }

    // Tap on empty canvas (pan started but didn't move) → deselect
    if (isPanning && !panMovedRef.current) {
      onSelectNode(null);
    }
    setIsPanning(false);
    lastPointerRef.current = null;
  };

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: PositionedNode) => {
    if (!editable) {
      return;
    }

    if (event.shiftKey) {
      onToggleNodeSelection(item.node.id);
      return;
    }

    onSelectNode(item.node.id);

    if (item.node.parentId === null) {
      // Root drag
      event.currentTarget.setPointerCapture(event.pointerId);
      rootDraggingRef.current = true;
      setRootDragging({
        nodeId: item.node.id,
        startLayoutX: item.x,
        startLayoutY: item.y,
        startPointerX: event.clientX,
        startPointerY: event.clientY,
      });
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragDescendantsRef.current = getDescendantIds(nodes, item.node.id);
    setDragging({
      nodeId: item.node.id,
      parentId: item.node.parentId,
      currentY: item.y + item.height / 2,
    });
    setDropIndex(null);
  };

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editable) {
      return;
    }

    if (rootDragging) {
      const deltaX = (event.clientX - rootDragging.startPointerX) / scaleRef.current;
      const deltaY = (event.clientY - rootDragging.startPointerY) / scaleRef.current;
      setRootDragOffset({ x: deltaX, y: deltaY });
      return;
    }

    if (!dragging) {
      return;
    }

    const pointerLayoutX = (event.clientX - panRef.current.x) / scaleRef.current - offsetRef.current.x;
    const pointerLayoutY = (event.clientY - panRef.current.y) / scaleRef.current - offsetRef.current.y;

    // Hit-test for reparent: is pointer over another node?
    const draggedDescendants = dragDescendantsRef.current ?? new Set<string>([dragging.nodeId]);
    let foundTarget: string | null = null;

    for (const pos of positioned) {
      if (pos.node.id === dragging.nodeId) continue;
      if (draggedDescendants.has(pos.node.id)) continue;
      if (
        pointerLayoutX >= pos.x &&
        pointerLayoutX <= pos.x + pos.width &&
        pointerLayoutY >= pos.y &&
        pointerLayoutY <= pos.y + pos.height
      ) {
        foundTarget = pos.node.id;
        break;
      }
    }

    if (foundTarget && foundTarget !== dragging.parentId) {
      setReparentTarget({ targetNodeId: foundTarget, pointerLayoutX, pointerLayoutY });
      setDropIndex(null);
    } else {
      setReparentTarget(null);
      const siblings = (positionedByParent.get(dragging.parentId) || []).filter(
        (item) => item.node.id !== dragging.nodeId,
      );
      const nextDropIndex = getSiblingDropIndex(siblings, pointerLayoutY);
      setDropIndex(nextDropIndex);
    }

    setDragging({
      ...dragging,
      currentY: pointerLayoutY,
    });
  };

  const handleNodePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editable) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (rootDragging) {
      if (rootDragOffset) {
        const finalX = rootDragging.startLayoutX + rootDragOffset.x;
        const finalY = rootDragging.startLayoutY + rootDragOffset.y;
        onMoveRootNode(rootDragging.nodeId, finalX, finalY);
      }
      rootDraggingRef.current = false;
      setRootDragging(null);
      setRootDragOffset(null);
      return;
    }

    if (!dragging) {
      return;
    }

    if (reparentTarget) {
      const targetChildren = nodes.filter((n) => n.parentId === reparentTarget.targetNodeId);
      onMoveNode(dragging.nodeId, reparentTarget.targetNodeId, targetChildren.length);
      setDragging(null);
      setDropIndex(null);
      setReparentTarget(null);
      dragDescendantsRef.current = null;
      return;
    }

    const siblings = positionedByParent.get(dragging.parentId) || [];
    const currentIndex = siblings.findIndex((item) => item.node.id === dragging.nodeId);
    const nextIndex = dropIndex ?? currentIndex;

    if (currentIndex !== -1 && nextIndex !== currentIndex) {
      onMoveNode(dragging.nodeId, dragging.parentId, nextIndex);
    }

    setDragging(null);
    setDropIndex(null);
    setReparentTarget(null);
    dragDescendantsRef.current = null;
  };

  const dropGuide = (() => {
    if (!dragging || dropIndex === null) {
      return null;
    }

    const siblings = positionedByParent.get(dragging.parentId) || [];
    if (siblings.length === 0) {
      return null;
    }

    const targetX = siblings[0].x;

    if (dropIndex <= 0) {
      return { x: targetX, y: siblings[0].y - 11 };
    }

    if (dropIndex >= siblings.length) {
      const last = siblings[siblings.length - 1];
      return { x: targetX, y: last.y + last.height + 11 };
    }

    const prev = siblings[dropIndex - 1];
    const next = siblings[dropIndex];
    return { x: targetX, y: (prev.y + prev.height + next.y) / 2 };
  })();

  return (
    <div className={editable ? "mindmap-canvas" : "mindmap-canvas mindmap-canvas--locked"}>
      <div className="mindmap-controls">
        <button
          type="button"
          className="mindmap-icon-btn"
          onClick={() => zoomByCenter(SCALE_STEP)}
          title="Zoom In"
          aria-label="Zoom In"
          disabled={!editable}
        >
          <span className="material-symbols-rounded">zoom_in</span>
        </button>
        <button
          type="button"
          className="mindmap-icon-btn"
          onClick={() => zoomByCenter(-SCALE_STEP)}
          title="Zoom Out"
          aria-label="Zoom Out"
          disabled={!editable}
        >
          <span className="material-symbols-rounded">zoom_out</span>
        </button>
        <button
          type="button"
          className="mindmap-icon-btn"
          onClick={fitToScreen}
          title="Fit to Screen"
          aria-label="Fit to Screen"
          disabled={!editable}
        >
          <span className="material-symbols-rounded">fit_screen</span>
        </button>
        <span className="mindmap-zoom-label">{zoomPercent}%</span>
      </div>

      <div
        ref={viewportRef}
        className={isPanning ? "mindmap-viewport mindmap-viewport--panning" : "mindmap-viewport"}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onDoubleClick={handleViewportDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="mindmap-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: "top left",
            width,
            height,
          }}
        >
          <div className="mindmap-wrap">
            <svg className="mindmap-lines" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
              <defs>
                <marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth">
                  <path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" />
                </marker>
                <marker id="edge-dot" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto" markerUnits="strokeWidth">
                  <circle cx="3" cy="3" r="3" fill="context-stroke" />
                </marker>
              </defs>
              {positioned.map((item) => {
                if (!item.node.parentId) {
                  return null;
                }

                const parent = byId.get(item.node.parentId);
                if (!parent) {
                  return null;
                }

                const branchIdx = branchColorMap.get(item.node.id);
                const branchClass = branchIdx !== undefined ? ` mindmap-branch--${branchIdx}` : "";

                // Use parent's layout context for edge connection style
                const edgeAligned = item.parentAligned ?? item.aligned;
                const edgeDir = item.parentDirection ?? item.direction;

                let x1: number, y1: number, x2: number, y2: number;
                if (edgeAligned && (edgeDir === "right" || edgeDir === "left")) {
                  // Horizontal tree chart: edge departs from parent bottom center (XMind style)
                  x1 = parent.x + parent.width / 2 + offsetX;
                  y1 = parent.y + parent.height + offsetY;
                  x2 = edgeDir === "right"
                    ? item.x + offsetX
                    : item.x + item.width + offsetX;
                  y2 = item.y + item.height / 2 + offsetY;
                } else if (edgeDir === "down") {
                  x1 = parent.x + parent.width / 2 + offsetX;
                  y1 = parent.y + parent.height + offsetY;
                  x2 = item.x + item.width / 2 + offsetX;
                  y2 = item.y + offsetY;
                } else if (edgeDir === "up") {
                  x1 = parent.x + parent.width / 2 + offsetX;
                  y1 = parent.y + offsetY;
                  x2 = item.x + item.width / 2 + offsetX;
                  y2 = item.y + item.height + offsetY;
                } else if (edgeDir === "left") {
                  x1 = parent.x + offsetX;
                  y1 = parent.y + parent.height / 2 + offsetY;
                  x2 = item.x + item.width + offsetX;
                  y2 = item.y + item.height / 2 + offsetY;
                } else {
                  x1 = parent.x + parent.width + offsetX;
                  y1 = parent.y + parent.height / 2 + offsetY;
                  x2 = item.x + offsetX;
                  y2 = item.y + item.height / 2 + offsetY;
                }

                const edgeStyle = item.node.edgeStyle ?? "curve";
                const edgeEnd = item.node.edgeEnd ?? "none";
                const treeMode = edgeAligned === true;
                const bottomStart = treeMode && (edgeDir === "right" || edgeDir === "left");
                const d = buildEdgePath(x1, y1, x2, y2, edgeDir, edgeStyle, treeMode, bottomStart);

                const inlineStyle: React.CSSProperties = {};
                if (item.node.edgeWidth != null) inlineStyle.strokeWidth = item.node.edgeWidth;
                if (item.node.edgeColor) inlineStyle.stroke = item.node.edgeColor;

                const markerEnd = edgeEnd === "arrow" ? "url(#edge-arrow)"
                  : edgeEnd === "dot" ? "url(#edge-dot)"
                  : undefined;

                return (
                  <path
                    key={`edge-${item.node.id}`}
                    className={`mindmap-edge${branchClass}`}
                    d={d}
                    style={inlineStyle}
                    markerEnd={markerEnd}
                  />
                );
              })}

              {dropGuide ? (
                <line
                  className="mindmap-drop-guide"
                  x1={dropGuide.x + offsetX - 80}
                  y1={dropGuide.y + offsetY}
                  x2={dropGuide.x + offsetX + 90}
                  y2={dropGuide.y + offsetY}
                />
              ) : null}

              {reparentTarget && dragging ? (() => {
                const target = byId.get(reparentTarget.targetNodeId);
                if (!target) return null;

                let tx: number, ty: number;
                if (reparentTarget.pointerLayoutX > target.x + target.width) {
                  tx = target.x + target.width + offsetX;
                  ty = target.y + target.height / 2 + offsetY;
                } else if (reparentTarget.pointerLayoutX < target.x) {
                  tx = target.x + offsetX;
                  ty = target.y + target.height / 2 + offsetY;
                } else if (reparentTarget.pointerLayoutY > target.y + target.height) {
                  tx = target.x + target.width / 2 + offsetX;
                  ty = target.y + target.height + offsetY;
                } else {
                  tx = target.x + target.width / 2 + offsetX;
                  ty = target.y + offsetY;
                }

                const px = reparentTarget.pointerLayoutX + offsetX;
                const py = reparentTarget.pointerLayoutY + offsetY;
                const previewD = buildEdgePath(tx, ty, px, py, "right");

                return (
                  <>
                    <rect
                      x={target.x + offsetX - 3}
                      y={target.y + offsetY - 3}
                      width={target.width + 6}
                      height={target.height + 6}
                      rx={10}
                      className="mindmap-reparent-highlight"
                    />
                    <path className="mindmap-reparent-preview" d={previewD} />
                  </>
                );
              })() : null}
            </svg>

            <div className="mindmap-nodes" style={{ width, height }}>
              {positioned.map((item) => {
                const hasChildren = parentIdSet.has(item.node.id);
                const isCollapsed = collapsedSet.has(item.node.id);
                const isRoot = item.direction === "root";
                const branchIdx = branchColorMap.get(item.node.id);
                const branchClass = branchIdx !== undefined ? ` mindmap-branch--${branchIdx}` : "";
                const selectedClass = selectedSet.has(item.node.id) ? " map-node--selected" : "";
                const rootClass = isRoot ? " map-node--root" : "";
                const reparentClass = reparentTarget?.targetNodeId === item.node.id ? " map-node--reparent-target" : "";
                return (
                  <button
                    key={item.node.id}
                    type="button"
                    className={`map-node${rootClass}${selectedClass}${branchClass}${reparentClass}`}
                    style={{
                      left: item.x + offsetX,
                      top: item.y + offsetY,
                      width: item.width,
                      height: item.height,
                      ...(item.node.borderRadius != null ? { borderRadius: item.node.borderRadius } : {}),
                      ...(item.node.bgColor ? { backgroundColor: item.node.bgColor } : {}),
                      ...(item.node.borderWidth != null ? { borderWidth: item.node.borderWidth } : {}),
                      ...(item.node.borderColor ? { borderColor: item.node.borderColor } : {}),
                      ...(item.node.textColor ? { color: item.node.textColor } : {}),
                    }}
                    onDoubleClick={() => startRename(item.node.id, item.node.title)}
                    onPointerDown={(event) => handleNodePointerDown(event, item)}
                    onPointerMove={handleNodePointerMove}
                    onPointerUp={handleNodePointerUp}
                    onPointerCancel={handleNodePointerUp}
                  >
                    {editingNodeId === item.node.id ? (
                      <input
                        className="map-node__rename-input"
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            finishRename();
                            return;
                          }

                          if (event.key === "Escape") {
                            event.preventDefault();
                            finishRename({ cancel: true });
                          }
                        }}
                        onBlur={() => finishRename()}
                        autoFocus
                      />
                    ) : (
                      <span className="map-node__title">
                        {showWbsNumbers ? (() => {
                          const wbsLabel = wbsNumbers.get(item.node.id);
                          return wbsLabel ? <span className="map-node__wbs-number">{wbsLabel}</span> : null;
                        })() : null}
                        {item.node.title}
                      </span>
                    )}
                    {hasChildren ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="map-node__collapse"
                        aria-label={isCollapsed ? "Expand node" : "Collapse node"}
                        onPointerDown={(event) => {
                          if (!editable) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          onToggleCollapse(item.node.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            if (!editable) {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleCollapse(item.node.id);
                          }
                        }}
                      >
                        {isCollapsed ? "+" : "−"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {marquee ? (
          <div
            className="mindmap-marquee"
            style={{
              position: "absolute",
              left: Math.min(marquee.startX, marquee.currentX),
              top: Math.min(marquee.startY, marquee.currentY),
              width: Math.abs(marquee.currentX - marquee.startX),
              height: Math.abs(marquee.currentY - marquee.startY),
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
