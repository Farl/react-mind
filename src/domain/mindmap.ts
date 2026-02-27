export type MindmapNode = {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
};

export type MindmapEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type MindmapSnapshot = {
  id: string;
  createdAtIso: string;
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  source: "manual" | "import" | "sync";
};

export type MindmapDocument = {
  id: string;
  title: string;
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  updatedAtIso: string;
};

export const createEmptyMindmap = (id: string, title: string): MindmapDocument => ({
  id,
  title,
  nodes: [
    {
      id: "root",
      title,
      parentId: null,
      order: 0,
    },
  ],
  edges: [],
  updatedAtIso: new Date().toISOString(),
});
