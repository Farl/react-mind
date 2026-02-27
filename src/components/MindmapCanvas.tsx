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
  onSelectNode: (nodeId: string) => void;
};

const NODE_WIDTH = 170;
const NODE_HEIGHT = 42;
const H_GAP = 180;
const V_GAP = 22;

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

const buildSubtreeHeight = (nodeId: string, childrenMap: Map<string | null, MindmapNode[]>): number => {
  const children = childrenMap.get(nodeId) || [];
  if (children.length === 0) {
    return NODE_HEIGHT;
  }

  const childHeights: number[] = children.map((child) => buildSubtreeHeight(child.id, childrenMap));
  return childHeights.reduce((sum: number, h: number) => sum + h, 0) + V_GAP * (children.length - 1);
};

const layoutNodes = (nodes: MindmapNode[]): PositionedNode[] => {
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
    const subtreeHeight = buildSubtreeHeight(nodeId, childrenMap);
    const centerY = top + subtreeHeight / 2;
    const x = (depthMap.get(nodeId) || 0) * H_GAP;

    positioned.set(nodeId, {
      node,
      x,
      y: centerY - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });

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

export function MindmapCanvas({ nodes, selectedNodeId, onSelectNode }: MindmapCanvasProps) {
  const positioned = layoutNodes(nodes);
  const byId = new Map(positioned.map((item) => [item.node.id, item]));

  const maxX = positioned.reduce((m, n) => Math.max(m, n.x + n.width), 0);
  const maxY = positioned.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  const width = maxX + 80;
  const height = maxY + 80;

  return (
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

          return <path key={`edge-${item.node.id}`} d={`M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`} />;
        })}
      </svg>

      <div className="mindmap-nodes" style={{ width, height }}>
        {positioned.map((item) => (
          <button
            key={item.node.id}
            type="button"
            className={item.node.id === selectedNodeId ? "map-node map-node--selected" : "map-node"}
            style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
            onClick={() => onSelectNode(item.node.id)}
          >
            {item.node.title}
          </button>
        ))}
      </div>
    </div>
  );
}
