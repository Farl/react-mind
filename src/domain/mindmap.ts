export type LayoutMode = "balanced" | "right" | "left" | "down" | "up" | "right-aligned" | "left-aligned" | "down-aligned" | "up-aligned";

const LAYOUT_MODES: ReadonlySet<string> = new Set<LayoutMode>(["balanced", "right", "left", "down", "up", "right-aligned", "left-aligned", "down-aligned", "up-aligned"]);
export const isLayoutMode = (v: unknown): v is LayoutMode => typeof v === "string" && LAYOUT_MODES.has(v);

export type EdgeStyle = "curve" | "straight" | "orthogonal" | "rounded";
export type EdgeEnd = "none" | "arrow" | "dot";

const EDGE_STYLES: ReadonlySet<string> = new Set<EdgeStyle>(["curve", "straight", "orthogonal", "rounded"]);
export const isEdgeStyle = (v: unknown): v is EdgeStyle => typeof v === "string" && EDGE_STYLES.has(v);

const EDGE_ENDS: ReadonlySet<string> = new Set<EdgeEnd>(["none", "arrow", "dot"]);
export const isEdgeEnd = (v: unknown): v is EdgeEnd => typeof v === "string" && EDGE_ENDS.has(v);

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
  edgeStyle?: EdgeStyle;   // controls edge FROM parent TO this node (default "curve")
  edgeEnd?: EdgeEnd;       // end marker (default "none")
  edgeWidth?: number;      // stroke width (default 2.5)
  edgeColor?: string;      // override auto branch color
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

/** Collect a node and all its descendants (BFS). */
export const getDescendantIds = (nodes: MindmapNode[], rootId: string): Set<string> => {
  const descendants = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    nodes.forEach((n) => {
      if (n.parentId && descendants.has(n.parentId) && !descendants.has(n.id)) {
        descendants.add(n.id);
        changed = true;
      }
    });
  }
  return descendants;
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
