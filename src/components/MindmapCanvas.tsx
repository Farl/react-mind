import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LayoutMode, MindmapNode } from "../domain/mindmap";
import { getDescendantIds } from "../domain/mindmap";

type PositionedNode = {
  node: MindmapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: "left" | "right" | "root" | "down" | "up";
};

type MindmapCanvasProps = {
  nodes: MindmapNode[];
  selectedNodeIds: string[];
  collapsedNodeIds: string[];
  editable: boolean;
  layoutMode: LayoutMode;
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
const H_GAP = 180;
const V_GAP = 22;
const BETWEEN_GAP = H_GAP - NODE_WIDTH; // 10px
const CANVAS_PAD = 80;
// Vertical layout constants
const V_LEVEL_GAP = 64; // gap between depth levels (top-to-bottom)
const H_NODE_GAP = 20; // gap between siblings in vertical layouts
const MIN_SCALE = 0.5;
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

const buildSubtreeHeight = (
  nodeId: string,
  childrenMap: Map<string | null, MindmapNode[]>,
  collapsedNodeIds: Set<string>,
): number => {
  if (collapsedNodeIds.has(nodeId)) {
    return NODE_HEIGHT;
  }

  const children = childrenMap.get(nodeId) || [];
  if (children.length === 0) {
    return NODE_HEIGHT;
  }

  const childHeights: number[] = children.map((child) =>
    buildSubtreeHeight(child.id, childrenMap, collapsedNodeIds),
  );
  return childHeights.reduce((sum: number, h: number) => sum + h, 0) + V_GAP * (children.length - 1);
};

const computeGroupHeight = (
  nodes: MindmapNode[],
  childrenMap: Map<string | null, MindmapNode[]>,
  collapsedNodeIds: Set<string>,
): number => {
  if (nodes.length === 0) return 0;
  const heights = nodes.map((n) => buildSubtreeHeight(n.id, childrenMap, collapsedNodeIds));
  return heights.reduce((sum, h) => sum + h, 0) + V_GAP * (nodes.length - 1);
};

const buildSubtreeWidth = (
  nodeId: string,
  childrenMap: Map<string | null, MindmapNode[]>,
  collapsedNodeIds: Set<string>,
): number => {
  if (collapsedNodeIds.has(nodeId)) return NODE_WIDTH;
  const children = childrenMap.get(nodeId) || [];
  if (children.length === 0) return NODE_WIDTH;
  const widths = children.map((c) => buildSubtreeWidth(c.id, childrenMap, collapsedNodeIds));
  return widths.reduce((s, w) => s + w, 0) + H_NODE_GAP * (children.length - 1);
};

const computeGroupWidth = (
  nodes: MindmapNode[],
  childrenMap: Map<string | null, MindmapNode[]>,
  collapsedNodeIds: Set<string>,
): number => {
  if (nodes.length === 0) return 0;
  const widths = nodes.map((n) => buildSubtreeWidth(n.id, childrenMap, collapsedNodeIds));
  return widths.reduce((s, w) => s + w, 0) + H_NODE_GAP * (nodes.length - 1);
};

const layoutNodesHorizontal = (
  nodes: MindmapNode[],
  roots: MindmapNode[],
  collapsedNodeIds: Set<string>,
  layoutMode: "balanced" | "right" | "left",
): PositionedNode[] => {
  const childrenMap = groupByParent(nodes);
  const positioned = new Map<string, PositionedNode>();

  roots.forEach((root, rootIdx) => {
    const rootLayoutX = root.x ?? rootIdx * 800;
    const rootLayoutY = root.y ?? 200;

    const rootChildren = childrenMap.get(root.id) || [];

    let rightChildren: MindmapNode[];
    let leftChildren: MindmapNode[];

    const effectiveLayout = root.nodeLayout ?? layoutMode;
    if (effectiveLayout === "balanced" && rootChildren.length > 0) {
      const rightCount = Math.ceil(rootChildren.length / 2);
      rightChildren = rootChildren.slice(0, rightCount);
      leftChildren = rootChildren.slice(rightCount);
    } else if (effectiveLayout === "left") {
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

    const placeSubtree = (nodeId: string, topAbsolute: number, dir: "left" | "right", depth: number): number => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return 0;

      const subtreeH = buildSubtreeHeight(nodeId, childrenMap, collapsedNodeIds);
      const y = topAbsolute + subtreeH / 2 - NODE_HEIGHT / 2;

      const x =
        dir === "right"
          ? rootLayoutX + ROOT_NODE_WIDTH + BETWEEN_GAP + (depth - 1) * H_GAP
          : rootLayoutX - BETWEEN_GAP - NODE_WIDTH - (depth - 1) * H_GAP;

      positioned.set(nodeId, { node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, direction: dir });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        const effectiveLayout = node.nodeLayout ?? null;

        if (effectiveLayout === "balanced" && children.length > 0) {
          const rightCount = Math.ceil(children.length / 2);
          const rightKids = children.slice(0, rightCount);
          const leftKids = children.slice(rightCount);
          const rightGroupH = computeGroupHeight(rightKids, childrenMap, collapsedNodeIds);
          let cursor = topAbsolute + subtreeH / 2 - rightGroupH / 2;
          rightKids.forEach((child) => {
            const h = placeSubtree(child.id, cursor, "right", depth + 1);
            cursor += h + V_GAP;
          });
          const leftGroupH = computeGroupHeight(leftKids, childrenMap, collapsedNodeIds);
          cursor = topAbsolute + subtreeH / 2 - leftGroupH / 2;
          leftKids.forEach((child) => {
            const h = placeSubtree(child.id, cursor, "left", depth + 1);
            cursor += h + V_GAP;
          });
        } else {
          const childDir: "left" | "right" =
            effectiveLayout === "right" ? "right" : effectiveLayout === "left" ? "left" : dir;
          let cursor = topAbsolute;
          children.forEach((child) => {
            const h = placeSubtree(child.id, cursor, childDir, depth + 1);
            cursor += h + V_GAP;
          });
        }
      }

      return subtreeH;
    };

    const rightGroupH = computeGroupHeight(rightChildren, childrenMap, collapsedNodeIds);
    let cursor = rootLayoutY + ROOT_NODE_HEIGHT / 2 - rightGroupH / 2;
    rightChildren.forEach((child) => {
      const h = placeSubtree(child.id, cursor, "right", 1);
      cursor += h + V_GAP;
    });

    const leftGroupH = computeGroupHeight(leftChildren, childrenMap, collapsedNodeIds);
    cursor = rootLayoutY + ROOT_NODE_HEIGHT / 2 - leftGroupH / 2;
    leftChildren.forEach((child) => {
      const h = placeSubtree(child.id, cursor, "left", 1);
      cursor += h + V_GAP;
    });
  });

  return Array.from(positioned.values());
};

const layoutNodesVertical = (
  nodes: MindmapNode[],
  roots: MindmapNode[],
  collapsedNodeIds: Set<string>,
  mode: "down" | "up",
): PositionedNode[] => {
  const childrenMap = groupByParent(nodes);
  const positioned = new Map<string, PositionedNode>();

  roots.forEach((root, rootIdx) => {
    const rootLayoutX = root.x ?? rootIdx * 800;
    const rootLayoutY = root.y ?? 200;

    const rootChildren = childrenMap.get(root.id) || [];
    const totalChildrenWidth = computeGroupWidth(rootChildren, childrenMap, collapsedNodeIds);
    const childrenStartX =
      rootChildren.length > 0 ? rootLayoutX + ROOT_NODE_WIDTH / 2 - totalChildrenWidth / 2 : rootLayoutX;

    positioned.set(root.id, {
      node: root,
      x: rootLayoutX,
      y: rootLayoutY,
      width: ROOT_NODE_WIDTH,
      height: ROOT_NODE_HEIGHT,
      direction: "root",
    });

    const placeSubtree = (nodeId: string, leftEdge: number, depth: number): void => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const sw = buildSubtreeWidth(nodeId, childrenMap, collapsedNodeIds);
      const x = leftEdge + sw / 2 - NODE_WIDTH / 2;
      const y =
        mode === "down"
          ? rootLayoutY + ROOT_NODE_HEIGHT + V_LEVEL_GAP + (depth - 1) * (NODE_HEIGHT + V_LEVEL_GAP)
          : rootLayoutY - V_LEVEL_GAP - NODE_HEIGHT - (depth - 1) * (NODE_HEIGHT + V_LEVEL_GAP);

      positioned.set(nodeId, { node, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, direction: mode });

      if (!collapsedNodeIds.has(nodeId)) {
        const children = childrenMap.get(nodeId) || [];
        let cursor = leftEdge;
        children.forEach((child) => {
          const childW = buildSubtreeWidth(child.id, childrenMap, collapsedNodeIds);
          placeSubtree(child.id, cursor, depth + 1);
          cursor += childW + H_NODE_GAP;
        });
      }
    };

    let cursor = childrenStartX;
    rootChildren.forEach((child) => {
      const childW = buildSubtreeWidth(child.id, childrenMap, collapsedNodeIds);
      placeSubtree(child.id, cursor, 1);
      cursor += childW + H_NODE_GAP;
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
    if (effective === "down" || effective === "up") {
      results.push(...layoutNodesVertical(nodes, [root], collapsedNodeIds, effective));
    } else {
      results.push(...layoutNodesHorizontal(nodes, [root], collapsedNodeIds, effective));
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

const buildEdgePath = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
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
  // right
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(20, dx * 0.4);
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
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

    if (event.button !== 0 || !viewportRef.current) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".map-node")) {
      return;
    }

    viewportRef.current.setPointerCapture(event.pointerId);

    if (event.shiftKey) {
      const rect = viewportRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setMarquee({ startX: x, startY: y, currentX: x, currentY: y });
      return;
    }

    setIsPanning(true);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    panMovedRef.current = false;
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

    if (!panMovedRef.current && isPanning) {
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
      return { x: targetX, y: siblings[0].y - V_GAP / 2 };
    }

    if (dropIndex >= siblings.length) {
      const last = siblings[siblings.length - 1];
      return { x: targetX, y: last.y + last.height + V_GAP / 2 };
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

                let x1: number, y1: number, x2: number, y2: number;
                if (item.direction === "down") {
                  x1 = parent.x + parent.width / 2 + offsetX;
                  y1 = parent.y + parent.height + offsetY;
                  x2 = item.x + item.width / 2 + offsetX;
                  y2 = item.y + offsetY;
                } else if (item.direction === "up") {
                  x1 = parent.x + parent.width / 2 + offsetX;
                  y1 = parent.y + offsetY;
                  x2 = item.x + item.width / 2 + offsetX;
                  y2 = item.y + item.height + offsetY;
                } else if (item.direction === "left") {
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
                const d = buildEdgePath(x1, y1, x2, y2, item.direction);

                return (
                  <path key={`edge-${item.node.id}`} className={`mindmap-edge${branchClass}`} d={d} />
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
                      <span className="map-node__title">{item.node.title}</span>
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
