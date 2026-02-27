import { useMemo, useState } from "react";
import type { MindmapDocument, MindmapNode, MindmapSnapshot } from "../domain/mindmap";
import { createEmptyMindmap } from "../domain/mindmap";

type EditorState = {
  document: MindmapDocument;
  selectedNodeId: string | null;
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
    selectNode,
    addChildNode,
    addSiblingNode,
    renameNode,
    deleteNode,
    undo,
    redo,
    importDocument,
  };
};
