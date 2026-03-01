export type LayoutMode = "balanced" | "right" | "left" | "down" | "up";

const LAYOUT_MODES: ReadonlySet<string> = new Set<LayoutMode>(["balanced", "right", "left", "down", "up"]);
export const isLayoutMode = (v: unknown): v is LayoutMode => typeof v === "string" && LAYOUT_MODES.has(v);

export type MindmapNode = {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  x?: number;            // canvas-space absolute X (root nodes only)
  y?: number;            // canvas-space absolute Y (root nodes only)
  borderRadius?: number;  // px, e.g. 0=sharp, 8=rounded(default), 999=pill
  bgColor?: string;      // CSS color string, e.g. "#ffffff"
  borderWidth?: number;  // px
  borderColor?: string;  // CSS color string
  textColor?: string;    // CSS color string
  nodeLayout?: LayoutMode; // overrides global layout for this node's children
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
