import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MindmapNode } from "../domain/mindmap";

type PositionedNode = {
  node: MindmapNode;
  x: number;
  y: number;
  width: number;
  height: number;
};

type MindmapCanvasProps = {
  nodes: MindmapNode[];
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
  editable: boolean;
  onSelectNode: (nodeId: string) => void;
  onRenameNode: (nodeId: string, title: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onMoveNode: (nodeId: string, nextParentId: string, nextIndex: number) => void;
};

const NODE_WIDTH = 170;
const NODE_HEIGHT = 42;
const H_GAP = 180;
const V_GAP = 22;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const SCALE_STEP = 0.1;

type DraggingState = {
  nodeId: string;
  parentId: string;
  currentY: number;
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

const buildDepth = (rootId: string, childrenMap: Map<string | null, MindmapNode[]>) => {
  const depth = new Map<string, number>([[rootId, 0]]);
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const currentDepth = depth.get(current) || 0;
    const children = childrenMap.get(current) || [];

    children.forEach((child) => {
      depth.set(child.id, currentDepth + 1);
      queue.push(child.id);
    });
  }

  return depth;
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

  const childHeights: number[] = children.map((child) => buildSubtreeHeight(child.id, childrenMap, collapsedNodeIds));
  return childHeights.reduce((sum: number, h: number) => sum + h, 0) + V_GAP * (children.length - 1);
};

const layoutNodes = (nodes: MindmapNode[], collapsedNodeIds: Set<string>): PositionedNode[] => {
  if (nodes.length === 0) {
    return [];
  }

  const root = nodes.find((node) => node.parentId === null) || nodes[0];
  const childrenMap = groupByParent(nodes);
  const depthMap = buildDepth(root.id, childrenMap);

  const positioned = new Map<string, PositionedNode>();

  const place = (nodeId: string, top: number): number => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) {
      return NODE_HEIGHT;
    }

    const children = childrenMap.get(nodeId) || [];
    const subtreeHeight = buildSubtreeHeight(nodeId, childrenMap, collapsedNodeIds);
    const centerY = top + subtreeHeight / 2;
    const x = (depthMap.get(nodeId) || 0) * H_GAP;

    positioned.set(nodeId, {
      node,
      x,
      y: centerY - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });

    if (collapsedNodeIds.has(nodeId)) {
      return NODE_HEIGHT;
    }

    let cursorTop = top;
    children.forEach((child) => {
      const childHeight = place(child.id, cursorTop);
      cursorTop += childHeight + V_GAP;
    });

    return subtreeHeight;
  };

  place(root.id, 0);

  return Array.from(positioned.values());
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
  selectedNodeId,
  collapsedNodeIds,
  editable,
  onSelectNode,
  onRenameNode,
  onToggleCollapse,
  onMoveNode,
}: MindmapCanvasProps) {
  const collapsedSet = useMemo(() => new Set(collapsedNodeIds), [collapsedNodeIds]);
  const hiddenSet = useMemo(() => getHiddenByCollapse(nodes, collapsedSet), [nodes, collapsedSet]);
  const visibleNodes = useMemo(() => nodes.filter((node) => !hiddenSet.has(node.id)), [nodes, hiddenSet]);

  const positioned = layoutNodes(visibleNodes, collapsedSet);
  const byId = new Map(positioned.map((item) => [item.node.id, item]));

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 48, y: 48 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragging, setDragging] = useState<DraggingState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 48, y: 48 });
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const maxX = positioned.reduce((m, n) => Math.max(m, n.x + n.width), 0);
  const maxY = positioned.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  const width = maxX + 80;
  const height = maxY + 80;

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
    return () => {
      viewport.removeEventListener("wheel", handleViewportWheel);
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
    setIsPanning(true);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
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
  };

  const handleViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) {
      return;
    }

    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId);
    }

    setIsPanning(false);
    lastPointerRef.current = null;
  };

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: PositionedNode) => {
    if (!editable) {
      return;
    }

    onSelectNode(item.node.id);

    if (item.node.parentId === null) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
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

    if (!dragging) {
      return;
    }

    const svgPointY = (event.clientY - panRef.current.y) / scaleRef.current;
    const siblings = (positionedByParent.get(dragging.parentId) || []).filter((item) => item.node.id !== dragging.nodeId);
    const nextDropIndex = getSiblingDropIndex(siblings, svgPointY);

    setDragging({
      ...dragging,
      currentY: svgPointY,
    });
    setDropIndex(nextDropIndex);
  };

  const handleNodePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editable) {
      return;
    }

    if (!dragging) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const siblings = positionedByParent.get(dragging.parentId) || [];
    const currentIndex = siblings.findIndex((item) => item.node.id === dragging.nodeId);
    const nextIndex = dropIndex ?? currentIndex;

    if (currentIndex !== -1 && nextIndex !== currentIndex) {
      onMoveNode(dragging.nodeId, dragging.parentId, nextIndex);
    }

    setDragging(null);
    setDropIndex(null);
  };

  const dropGuide = (() => {
    if (!dragging || dropIndex === null) {
      return null;
    }

    const siblings = positionedByParent.get(dragging.parentId) || [];
    if (siblings.length === 0) {
      return null;
    }

    const parent = byId.get(dragging.parentId);
    const targetX = parent ? parent.x + H_GAP : siblings[0].x;

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

                const x1 = parent.x + parent.width;
                const y1 = parent.y + parent.height / 2;
                const x2 = item.x;
                const y2 = item.y + item.height / 2;
                const c1x = x1 + 40;
                const c2x = x2 - 40;

                return (
                  <path key={`edge-${item.node.id}`} d={`M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`} />
                );
              })}

              {dropGuide ? <line className="mindmap-drop-guide" x1={dropGuide.x - 80} y1={dropGuide.y} x2={dropGuide.x + 90} y2={dropGuide.y} /> : null}
            </svg>

            <div className="mindmap-nodes" style={{ width, height }}>
              {positioned.map((item) => {
                const hasChildren = nodes.some((node) => node.parentId === item.node.id);
                const isCollapsed = collapsedSet.has(item.node.id);

                return (
                  <button
                    key={item.node.id}
                    type="button"
                    className={item.node.id === selectedNodeId ? "map-node map-node--selected" : "map-node"}
                    style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
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
      </div>
    </div>
  );
}
