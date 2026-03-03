import { useMemo, useState } from "react";
import type { EdgeEnd, EdgeStyle, LayoutMode, MindmapDocument, MindmapNode, MindmapSnapshot } from "../domain/mindmap";
import { createEmptyMindmap, getDescendantIds } from "../domain/mindmap";

type EditorState = {
  document: MindmapDocument;
  selectedNodeIds: string[];
  collapsedNodeIds: string[];
  history: MindmapSnapshot[];
  historyIndex: number;
};

const cloneNodes = (nodes: MindmapNode[]): MindmapNode[] =>
  nodes.map((node) => ({
    ...node,
  }));

const createSnapshot = (document: MindmapDocument, source: MindmapSnapshot["source"]): MindmapSnapshot => ({
  id: crypto.randomUUID(),
  createdAtIso: new Date().toISOString(),
  nodes: cloneNodes(document.nodes),
  edges: [...document.edges],
  source,
});

const withUpdatedTimestamp = (document: MindmapDocument): MindmapDocument => ({
  ...document,
  updatedAtIso: new Date().toISOString(),
});

const sortSiblingNodes = (nodes: MindmapNode[]): MindmapNode[] =>
  [...nodes].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

const buildChildrenMap = (nodes: MindmapNode[]): Map<string | null, MindmapNode[]> => {
  const map = new Map<string | null, MindmapNode[]>();
  nodes.forEach((node) => {
    const list = map.get(node.parentId) || [];
    list.push(node);
    map.set(node.parentId, list);
  });

  map.forEach((list, key) => {
    map.set(key, sortSiblingNodes(list));
  });

  return map;
};

const normalizeDocument = (document: MindmapDocument): MindmapDocument => {
  const hasAnyRoot = document.nodes.some((node) => node.parentId === null);
  if (hasAnyRoot) {
    return {
      ...document,
      nodes: cloneNodes(document.nodes),
      edges: [...document.edges],
    };
  }

  return {
    ...document,
    nodes: [
      {
        id: "root",
        title: document.title || "Main Topic",
        parentId: null,
        order: 0,
      },
      ...cloneNodes(document.nodes),
    ],
    edges: [...document.edges],
  };
};

export const useMindmapEditor = () => {
  const initialDocument = useMemo(() => createEmptyMindmap("local-default", "Main Topic"), []);

  const [state, setState] = useState<EditorState>(() => {
    const firstSnapshot = createSnapshot(initialDocument, "manual");
    return {
      document: initialDocument,
      selectedNodeIds: initialDocument.nodes[0] ? [initialDocument.nodes[0].id] : [],
      collapsedNodeIds: [],
      history: [firstSnapshot],
      historyIndex: 0,
    };
  });

  const pushHistory = (current: EditorState, document: MindmapDocument) => {
    const snapshot = createSnapshot(document, "manual");
    const nextHistory = current.history.slice(0, current.historyIndex + 1);
    nextHistory.push(snapshot);
    return {
      history: nextHistory,
      historyIndex: nextHistory.length - 1,
    };
  };

  const selectNode = (nodeId: string | null) => {
    setState((current) => ({
      ...current,
      selectedNodeIds: nodeId ? [nodeId] : [],
    }));
  };

  const toggleNodeSelection = (nodeId: string) => {
    setState((current) => {
      const idx = current.selectedNodeIds.indexOf(nodeId);
      if (idx >= 0) {
        const next = [...current.selectedNodeIds];
        next.splice(idx, 1);
        return { ...current, selectedNodeIds: next };
      }
      return { ...current, selectedNodeIds: [...current.selectedNodeIds, nodeId] };
    });
  };

  const selectNodes = (nodeIds: string[]) => {
    setState((current) => ({
      ...current,
      selectedNodeIds: nodeIds,
    }));
  };

  const addChildNode = (parentId: string) => {
    setState((current) => {
      const parent = current.document.nodes.find((node) => node.id === parentId);
      if (!parent) {
        return current;
      }

      const siblings = current.document.nodes.filter((node) => node.parentId === parentId);
      const newNode: MindmapNode = {
        id: crypto.randomUUID(),
        title: "New Node",
        parentId,
        order: siblings.length,
      };

      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: [...current.document.nodes, newNode],
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: [newNode.id],
        collapsedNodeIds: current.collapsedNodeIds.filter((id) => id !== parentId),
      };
    });
  };

  const addSiblingNode = (nodeId: string) => {
    setState((current) => {
      const currentNode = current.document.nodes.find((node) => node.id === nodeId);
      if (!currentNode || currentNode.parentId === null) {
        return current;
      }

      const siblings = current.document.nodes.filter((node) => node.parentId === currentNode.parentId);
      const newNode: MindmapNode = {
        id: crypto.randomUUID(),
        title: "New Node",
        parentId: currentNode.parentId,
        order: siblings.length,
      };

      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: [...current.document.nodes, newNode],
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: [newNode.id],
      };
    });
  };

  const addRootNode = (x?: number, y?: number) => {
    setState((current) => {
      const roots = current.document.nodes.filter((n) => n.parentId === null);
      const newNode: MindmapNode = {
        id: crypto.randomUUID(),
        title: "New Topic",
        parentId: null,
        order: roots.length,
        x,
        y,
      };

      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: [...current.document.nodes, newNode],
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: [newNode.id],
      };
    });
  };

  type NodeStyleProps = {
    borderRadius?: number | undefined;
    bgColor?: string | undefined;
    borderWidth?: number | undefined;
    borderColor?: string | undefined;
    textColor?: string | undefined;
    nodeLayout?: LayoutMode | undefined;
    edgeStyle?: EdgeStyle | undefined;
    edgeEnd?: EdgeEnd | undefined;
    edgeWidth?: number | undefined;
    edgeColor?: string | undefined;
  };

  const updateNodeStyle = (nodeId: string, style: NodeStyleProps) => {
    setState((current) => {
      const nextNodes = current.document.nodes.map((n) => (n.id === nodeId ? { ...n, ...style } : n));
      const nextDocument = withUpdatedTimestamp({ ...current.document, nodes: nextNodes });
      const historyState = pushHistory(current, nextDocument);
      return { ...current, ...historyState, document: nextDocument };
    });
  };

  const updateMultipleNodeStyles = (nodeIds: string[], style: NodeStyleProps) => {
    setState((current) => {
      const idSet = new Set(nodeIds);
      const nextNodes = current.document.nodes.map((n) => (idSet.has(n.id) ? { ...n, ...style } : n));
      const nextDocument = withUpdatedTimestamp({ ...current.document, nodes: nextNodes });
      const historyState = pushHistory(current, nextDocument);
      return { ...current, ...historyState, document: nextDocument };
    });
  };

  const moveRootNode = (nodeId: string, x: number, y: number) => {
    setState((current) => {
      const node = current.document.nodes.find((n) => n.id === nodeId);
      if (!node || node.parentId !== null) {
        return current;
      }

      const nextNodes = current.document.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n));
      const nextDocument = withUpdatedTimestamp({ ...current.document, nodes: nextNodes });
      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
      };
    });
  };

  const renameNode = (nodeId: string, title: string) => {
    setState((current) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return current;
      }

      const nextNodes = current.document.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              title: trimmed,
            }
          : node,
      );

      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: nextNodes,
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
      };
    });
  };

  const moveNode = (nodeId: string, nextParentId: string, nextIndex: number) => {
    setState((current) => {
      const movingNode = current.document.nodes.find((node) => node.id === nodeId);
      if (!movingNode || movingNode.parentId === null) {
        return current;
      }

      const targetParent = current.document.nodes.find((node) => node.id === nextParentId);
      if (!targetParent) {
        return current;
      }

      const descendants = getDescendantIds(current.document.nodes, movingNode.id);
      if (descendants.has(nextParentId)) {
        return current;
      }

      const remainingNodes = current.document.nodes
        .filter((node) => node.id !== movingNode.id)
        .map((node) => ({ ...node }));

      const targetSiblings = sortSiblingNodes(remainingNodes.filter((node) => node.parentId === nextParentId));
      const boundedIndex = Math.max(0, Math.min(nextIndex, targetSiblings.length));

      const insertedNode: MindmapNode = {
        ...movingNode,
        parentId: nextParentId,
      };

      targetSiblings.splice(boundedIndex, 0, insertedNode);

      const updatedNodesById = new Map<string, MindmapNode>();
      remainingNodes.forEach((node) => {
        updatedNodesById.set(node.id, node);
      });

      const affectedParentIds = new Set<string | null>([movingNode.parentId, nextParentId]);
      affectedParentIds.forEach((parentId) => {
        if (parentId === nextParentId) {
          targetSiblings.forEach((node, index) => {
            updatedNodesById.set(node.id, {
              ...node,
              parentId,
              order: index,
            });
          });
          return;
        }

        const siblings = sortSiblingNodes(
          remainingNodes.filter((node) => node.parentId === parentId),
        );

        siblings.forEach((node, index) => {
          updatedNodesById.set(node.id, {
            ...node,
            order: index,
          });
        });
      });

      const nextNodes = current.document.nodes
        .map((node) => updatedNodesById.get(node.id))
        .filter((node): node is MindmapNode => Boolean(node));

      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: nextNodes,
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: [nodeId],
      };
    });
  };

  const deleteNode = (nodeId: string) => {
    setState((current) => {
      const roots = current.document.nodes.filter((n) => n.parentId === null);
      // Block deletion if it's the only root node
      if (roots.length <= 1 && roots[0]?.id === nodeId) {
        return current;
      }

      const descendants = getDescendantIds(current.document.nodes, nodeId);
      const nextNodes = current.document.nodes.filter((node) => !descendants.has(node.id));
      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: nextNodes,
      });

      const historyState = pushHistory(current, nextDocument);

      const remainingRoots = nextNodes.filter((n) => n.parentId === null);
      const nextSelected = remainingRoots[0]?.id ?? nextNodes[0]?.id;

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: nextSelected ? [nextSelected] : [],
        collapsedNodeIds: current.collapsedNodeIds.filter((id) => !descendants.has(id)),
      };
    });
  };

  const deleteMultipleNodes = (nodeIds: string[]) => {
    setState((current) => {
      const toDelete = new Set<string>();
      for (const nodeId of nodeIds) {
        const descendants = getDescendantIds(current.document.nodes, nodeId);
        descendants.forEach((id) => toDelete.add(id));
      }

      const roots = current.document.nodes.filter((n) => n.parentId === null);
      const remainingRoots = roots.filter((r) => !toDelete.has(r.id));
      if (remainingRoots.length === 0 && roots[0]) {
        toDelete.delete(roots[0].id);
      }

      const nextNodes = current.document.nodes.filter((n) => !toDelete.has(n.id));
      const nextDocument = withUpdatedTimestamp({ ...current.document, nodes: nextNodes });
      const historyState = pushHistory(current, nextDocument);

      const nextSelected = current.selectedNodeIds.filter((id) => !toDelete.has(id));
      if (nextSelected.length === 0) {
        const fallback = nextNodes.filter((n) => n.parentId === null)[0]?.id ?? nextNodes[0]?.id;
        if (fallback) nextSelected.push(fallback);
      }

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: nextSelected,
        collapsedNodeIds: current.collapsedNodeIds.filter((id) => !toDelete.has(id)),
      };
    });
  };

  const toggleNodeCollapsed = (nodeId: string) => {
    setState((current) => {
      const hasChildren = current.document.nodes.some((node) => node.parentId === nodeId);
      if (!hasChildren) {
        return current;
      }

      const collapsed = new Set(current.collapsedNodeIds);
      if (collapsed.has(nodeId)) {
        collapsed.delete(nodeId);
      } else {
        collapsed.add(nodeId);
      }

      return {
        ...current,
        collapsedNodeIds: Array.from(collapsed),
      };
    });
  };

  const selectParentNode = () => {
    setState((current) => {
      const primaryId = current.selectedNodeIds[0];
      if (!primaryId) return current;

      const selected = current.document.nodes.find((node) => node.id === primaryId);
      if (!selected?.parentId) return current;

      return { ...current, selectedNodeIds: [selected.parentId] };
    });
  };

  const selectFirstChildNode = () => {
    setState((current) => {
      const primaryId = current.selectedNodeIds[0];
      if (!primaryId) return current;

      const selected = current.document.nodes.find((node) => node.id === primaryId);
      if (!selected) return current;

      const childrenMap = buildChildrenMap(current.document.nodes);
      const children = childrenMap.get(selected.id) || [];
      if (children.length === 0) return current;

      return { ...current, selectedNodeIds: [children[0].id] };
    });
  };

  const selectSiblingNode = (direction: -1 | 1) => {
    setState((current) => {
      const primaryId = current.selectedNodeIds[0];
      if (!primaryId) return current;

      const selected = current.document.nodes.find((node) => node.id === primaryId);
      if (!selected) return current;

      const siblings = sortSiblingNodes(
        current.document.nodes.filter((node) => node.parentId === selected.parentId),
      );
      const index = siblings.findIndex((node) => node.id === selected.id);
      if (index === -1) return current;

      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= siblings.length) return current;

      return { ...current, selectedNodeIds: [siblings[nextIndex].id] };
    });
  };

  const undo = () => {
    setState((current) => {
      if (current.historyIndex <= 0) {
        return current;
      }
      const nextIndex = current.historyIndex - 1;
      const snapshot = current.history[nextIndex];
      const nodeIdSet = new Set(snapshot.nodes.map((n) => n.id));
      return {
        ...current,
        historyIndex: nextIndex,
        document: {
          ...current.document,
          nodes: cloneNodes(snapshot.nodes),
          edges: [...snapshot.edges],
          updatedAtIso: snapshot.createdAtIso,
        },
        selectedNodeIds: current.selectedNodeIds.filter((id) => nodeIdSet.has(id)),
        collapsedNodeIds: [],
      };
    });
  };

  const redo = () => {
    setState((current) => {
      if (current.historyIndex >= current.history.length - 1) {
        return current;
      }
      const nextIndex = current.historyIndex + 1;
      const snapshot = current.history[nextIndex];
      const nodeIdSet = new Set(snapshot.nodes.map((n) => n.id));
      return {
        ...current,
        historyIndex: nextIndex,
        document: {
          ...current.document,
          nodes: cloneNodes(snapshot.nodes),
          edges: [...snapshot.edges],
          updatedAtIso: snapshot.createdAtIso,
        },
        selectedNodeIds: current.selectedNodeIds.filter((id) => nodeIdSet.has(id)),
        collapsedNodeIds: [],
      };
    });
  };

  const importDocument = (document: MindmapDocument) => {
    setState((current) => {
      const nextDocument = normalizeDocument(withUpdatedTimestamp(document));
      const historyState = pushHistory(current, nextDocument);
      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeIds: nextDocument.nodes[0] ? [nextDocument.nodes[0].id] : [],
        collapsedNodeIds: [],
      };
    });
  };

  const selectedNode = state.selectedNodeIds.length > 0
    ? state.document.nodes.find((node) => node.id === state.selectedNodeIds[0]) ?? null
    : null;
  const selectedNodes = useMemo(() => {
    const idSet = new Set(state.selectedNodeIds);
    return state.document.nodes.filter((n) => idSet.has(n.id));
  }, [state.document.nodes, state.selectedNodeIds]);
  const currentSnapshot = state.history[state.historyIndex] ?? null;

  return {
    document: state.document,
    selectedNode,
    selectedNodes,
    selectedNodeIds: state.selectedNodeIds,
    currentSnapshot,
    historyCount: state.history.length,
    historyIndex: state.historyIndex,
    collapsedNodeIds: state.collapsedNodeIds,
    selectNode,
    toggleNodeSelection,
    selectNodes,
    addChildNode,
    addSiblingNode,
    addRootNode,
    moveRootNode,
    updateNodeStyle,
    updateMultipleNodeStyles,
    renameNode,
    deleteNode,
    deleteMultipleNodes,
    toggleNodeCollapsed,
    selectParentNode,
    selectFirstChildNode,
    selectPrevSiblingNode: () => selectSiblingNode(-1),
    selectNextSiblingNode: () => selectSiblingNode(1),
    undo,
    redo,
    moveNode,
    importDocument,
  };
};
