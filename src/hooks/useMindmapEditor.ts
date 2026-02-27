import { useMemo, useState } from "react";
import type { MindmapDocument, MindmapNode, MindmapSnapshot } from "../domain/mindmap";
import { createEmptyMindmap } from "../domain/mindmap";

type EditorState = {
  document: MindmapDocument;
  selectedNodeId: string | null;
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

const getDescendantIds = (nodes: MindmapNode[], rootId: string): Set<string> => {
  const descendants = new Set<string>([rootId]);
  let hasNewItem = true;

  while (hasNewItem) {
    hasNewItem = false;
    nodes.forEach((node) => {
      if (node.parentId && descendants.has(node.parentId) && !descendants.has(node.id)) {
        descendants.add(node.id);
        hasNewItem = true;
      }
    });
  }

  return descendants;
};

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
  const hasRoot = document.nodes.some((node) => node.id === "root");
  if (hasRoot) {
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
      selectedNodeId: "root",
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
      selectedNodeId: nodeId,
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
        selectedNodeId: newNode.id,
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
        selectedNodeId: newNode.id,
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
      if (!movingNode || movingNode.id === "root") {
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
        selectedNodeId: nodeId,
      };
    });
  };

  const deleteNode = (nodeId: string) => {
    if (nodeId === "root") {
      return;
    }

    setState((current) => {
      const descendants = new Set<string>([nodeId]);
      let hasNewItem = true;

      while (hasNewItem) {
        hasNewItem = false;
        current.document.nodes.forEach((node) => {
          if (node.parentId && descendants.has(node.parentId) && !descendants.has(node.id)) {
            descendants.add(node.id);
            hasNewItem = true;
          }
        });
      }

      const nextNodes = current.document.nodes.filter((node) => !descendants.has(node.id));
      const nextDocument = withUpdatedTimestamp({
        ...current.document,
        nodes: nextNodes,
      });

      const historyState = pushHistory(current, nextDocument);

      return {
        ...current,
        ...historyState,
        document: nextDocument,
        selectedNodeId: "root",
        collapsedNodeIds: current.collapsedNodeIds.filter((id) => !descendants.has(id)),
      };
    });
  };

  const toggleNodeCollapsed = (nodeId: string) => {
    if (nodeId === "root") {
      return;
    }

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
      if (!current.selectedNodeId) {
        return current;
      }

      const selected = current.document.nodes.find((node) => node.id === current.selectedNodeId);
      if (!selected?.parentId) {
        return current;
      }

      return {
        ...current,
        selectedNodeId: selected.parentId,
      };
    });
  };

  const selectFirstChildNode = () => {
    setState((current) => {
      if (!current.selectedNodeId) {
        return current;
      }

      const selected = current.document.nodes.find((node) => node.id === current.selectedNodeId);
      if (!selected) {
        return current;
      }

      const childrenMap = buildChildrenMap(current.document.nodes);
      const children = childrenMap.get(selected.id) || [];
      if (children.length === 0) {
        return current;
      }

      return {
        ...current,
        selectedNodeId: children[0].id,
      };
    });
  };

  const selectSiblingNode = (direction: -1 | 1) => {
    setState((current) => {
      if (!current.selectedNodeId) {
        return current;
      }

      const selected = current.document.nodes.find((node) => node.id === current.selectedNodeId);
      if (!selected) {
        return current;
      }

      const siblings = sortSiblingNodes(
        current.document.nodes.filter((node) => node.parentId === selected.parentId),
      );
      const index = siblings.findIndex((node) => node.id === selected.id);
      if (index === -1) {
        return current;
      }

      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= siblings.length) {
        return current;
      }

      return {
        ...current,
        selectedNodeId: siblings[nextIndex].id,
      };
    });
  };

  const undo = () => {
    setState((current) => {
      if (current.historyIndex <= 0) {
        return current;
      }
      const nextIndex = current.historyIndex - 1;
      const snapshot = current.history[nextIndex];
      return {
        ...current,
        historyIndex: nextIndex,
        document: {
          ...current.document,
          nodes: cloneNodes(snapshot.nodes),
          edges: [...snapshot.edges],
          updatedAtIso: snapshot.createdAtIso,
        },
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
      return {
        ...current,
        historyIndex: nextIndex,
        document: {
          ...current.document,
          nodes: cloneNodes(snapshot.nodes),
          edges: [...snapshot.edges],
          updatedAtIso: snapshot.createdAtIso,
        },
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
        selectedNodeId: nextDocument.nodes[0]?.id ?? null,
        collapsedNodeIds: [],
      };
    });
  };

  const selectedNode = state.document.nodes.find((node) => node.id === state.selectedNodeId) ?? null;
  const currentSnapshot = state.history[state.historyIndex] ?? null;

  return {
    document: state.document,
    selectedNode,
    currentSnapshot,
    historyCount: state.history.length,
    historyIndex: state.historyIndex,
    collapsedNodeIds: state.collapsedNodeIds,
    selectNode,
    addChildNode,
    addSiblingNode,
    renameNode,
    deleteNode,
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
