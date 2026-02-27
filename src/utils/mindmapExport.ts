import type { MindmapDocument } from "../domain/mindmap";

type MindmapNodeSummary = {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
};

const buildChildrenMap = (document: MindmapDocument) => {
  const map = new Map<string | null, MindmapNodeSummary[]>();

  document.nodes.forEach((node) => {
    const list = map.get(node.parentId) || [];
    list.push(node);
    map.set(node.parentId, list);
  });

  map.forEach((list, key) => {
    map.set(
      key,
      [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    );
  });

  return map;
};

export const createDocumentSignature = (document: MindmapDocument): string =>
  JSON.stringify({
    title: document.title,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      parentId: node.parentId,
      order: node.order,
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    })),
  });

export const toXmindPasteText = (document: MindmapDocument): string => {
  const childrenMap = buildChildrenMap(document);
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const roots = childrenMap.get(null) || [];
  const lines: string[] = [];

  const walk = (nodeId: string, depth: number) => {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }

    lines.push(`${"\t".repeat(depth)}${node.title}`);
    const children = childrenMap.get(node.id) || [];
    children.forEach((child) => walk(child.id, depth + 1));
  };

  roots.forEach((root) => walk(root.id, 0));
  return lines.join("\n");
};

export const downloadTextFile = (
  fileName: string,
  content: string,
  mimeType = "text/plain;charset=utf-8",
) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};