import type { TopologyEdge, TopologyFlowId, TopologyLayer, TopologyNode } from './topology';
import { topologyEdges, topologyNodes } from './topology';

export const layerOrder: TopologyLayer[] = [
  'ingest',
  'storage+governance',
  'compute',
  'serving+AI',
  'app',
];

const layerLabels: Record<TopologyLayer, string> = {
  ingest: 'Ingest',
  'storage+governance': 'Storage + Governance',
  compute: 'Compute',
  'serving+AI': 'Serving + AI',
  app: 'App + User Experience',
};

const layerStyles: Record<TopologyLayer, { accent: string; fill: string; glow: string }> = {
  ingest: { accent: '#38bdf8', fill: '#082f49', glow: '#0ea5e9' },
  'storage+governance': { accent: '#34d399', fill: '#052e2b', glow: '#10b981' },
  compute: { accent: '#f59e0b', fill: '#3b2506', glow: '#f59e0b' },
  'serving+AI': { accent: '#c084fc', fill: '#2e1065', glow: '#a855f7' },
  app: { accent: '#fb7185', fill: '#3f101c', glow: '#f43f5e' },
};

const flowStyles: Record<TopologyFlowId, { color: string; duration: string }> = {
  'baseline-map-render': { color: '#38bdf8', duration: '4.5s' },
  'scenario-whatif-run': { color: '#f97316', duration: '3.4s' },
  'ai-advisor-request': { color: '#c084fc', duration: '3.8s' },
  'startup-sse-probe': { color: '#22c55e', duration: '4.2s' },
};

export type PositionedNode = TopologyNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
};

export type RenderedLayer = {
  layer: TopologyLayer;
  nodes: TopologyNode[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ArchitectureLayout = {
  width: number;
  height: number;
  positioned: Map<string, PositionedNode>;
  renderedLayers: RenderedLayer[];
};

export const architectureLayoutConfig = {
  width: 1180,
  nodeWidth: 248,
  nodeHeight: 92,
  minHorizontalGutter: 24,
  topPadding: 96,
  bottomPadding: 48,
  laneLeft: 54,
  laneWidth: 1072,
  layerX: 28,
  layerWidth: 1124,
  layerTopPadding: 48,
  layerBottomPadding: 24,
  rowGap: 24,
  layerGap: 30,
} as const;

function wrapLabel(label: string) {
  const words = label.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 25 && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 3);
}

export function getRenderedLayers(nodes: TopologyNode[]) {
  const byLayer = new Map<TopologyLayer, TopologyNode[]>(layerOrder.map((layer) => [layer, []]));
  for (const node of nodes) {
    byLayer.get(node.layer)?.push(node);
  }

  return layerOrder
    .map((layer) => ({ layer, nodes: byLayer.get(layer) ?? [] }))
    .filter((renderedLayer) => renderedLayer.nodes.length > 0);
}

function nodesPerRow(nodeCount: number) {
  const { laneWidth, minHorizontalGutter, nodeWidth } = architectureLayoutConfig;
  const maxPerRow = Math.max(1, Math.floor((laneWidth + minHorizontalGutter) / (nodeWidth + minHorizontalGutter)));

  return Math.min(nodeCount, maxPerRow);
}

export function buildLayout(nodes: TopologyNode[]): ArchitectureLayout {
  const renderedLayers = getRenderedLayers(nodes);
  const {
    bottomPadding,
    laneLeft,
    laneWidth,
    layerBottomPadding,
    layerGap,
    layerTopPadding,
    layerWidth,
    layerX,
    minHorizontalGutter,
    nodeHeight,
    nodeWidth,
    rowGap,
    topPadding,
    width,
  } = architectureLayoutConfig;

  const positioned = new Map<string, PositionedNode>();
  const layoutLayers: RenderedLayer[] = [];
  let currentY = topPadding;

  for (const { layer, nodes: layerNodes } of renderedLayers) {
    const perRow = nodesPerRow(layerNodes.length);
    const rowCount = Math.ceil(layerNodes.length / perRow);
    const layerHeight = layerTopPadding + rowCount * nodeHeight + (rowCount - 1) * rowGap + layerBottomPadding;
    layoutLayers.push({ layer, nodes: layerNodes, x: layerX, y: currentY, width: layerWidth, height: layerHeight });

    layerNodes.forEach((node, nodeIndex) => {
      const row = Math.floor(nodeIndex / perRow);
      const rowStart = row * perRow;
      const rowNodes = layerNodes.slice(rowStart, rowStart + perRow);
      const indexInRow = nodeIndex - rowStart;
      const availableGutter = (laneWidth - rowNodes.length * nodeWidth) / Math.max(1, rowNodes.length + 1);
      const gutter = Math.max(minHorizontalGutter, availableGutter);
      const rowContentWidth = rowNodes.length * nodeWidth + (rowNodes.length - 1) * gutter;
      const rowLeft = laneLeft + (laneWidth - rowContentWidth) / 2;

      positioned.set(node.id, {
        ...node,
        x: rowLeft + indexInRow * (nodeWidth + gutter),
        y: currentY + layerTopPadding + row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
        row,
      });
    });

    currentY += layerHeight + layerGap;
  }

  return {
    width,
    height: currentY - layerGap + bottomPadding,
    positioned,
    renderedLayers: layoutLayers,
  };
}

function edgePath(from: PositionedNode, to: PositionedNode, edgeIndex: number) {
  const bow = (edgeIndex % 3) * 20 - 20;

  if (from.y === to.y) {
    const fromCenterX = from.x + from.width / 2;
    const toCenterX = to.x + to.width / 2;
    const direction = fromCenterX < toCenterX ? 1 : -1;
    const startX = from.x + (direction > 0 ? from.width : 0);
    const endX = to.x + (direction > 0 ? 0 : to.width);
    const centerY = from.y + from.height / 2;
    const controlY = from.y - 34 - Math.abs(bow) / 2;

    return `M ${startX} ${centerY} C ${startX + direction * 64} ${controlY}, ${endX - direction * 64} ${controlY}, ${endX} ${centerY}`;
  }

  const startX = from.x + from.width / 2;
  const startY = from.y + (from.y < to.y ? from.height : 0);
  const endX = to.x + to.width / 2;
  const endY = to.y + (from.y < to.y ? 0 : to.height);
  const midY = (startY + endY) / 2 + bow;

  return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
}

type ArchitectureDiagramProps = {
  selectedNodeId?: string;
  onSelectNode?: (node: TopologyNode) => void;
};

export function ArchitectureDiagram({ selectedNodeId, onSelectNode }: ArchitectureDiagramProps) {
  const layout = buildLayout(topologyNodes);
  const positions = layout.positioned;

  return (
    <div className="overflow-hidden rounded-2xl border bg-slate-950 text-white shadow-2xl shadow-slate-950/30">
      <svg
        role="img"
        aria-label="California Traffic What-If architecture topology with animated request flows"
        className="h-auto w-full"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
      >
        <defs>
          <filter id="architecture-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="architecture-backdrop" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#020617" />
            <stop offset="52%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#111827" />
          </linearGradient>
          <style>{`
            .architecture-flow-line {
              animation: architecture-dash 1.1s linear infinite;
            }
            .architecture-flow-dot {
              animation: architecture-pulse 1.4s ease-in-out infinite;
            }
            @keyframes architecture-dash {
              to { stroke-dashoffset: -36; }
            }
            @keyframes architecture-pulse {
              0%, 100% { opacity: 0.45; r: 4; }
              50% { opacity: 1; r: 7; }
            }
            @media (prefers-reduced-motion: reduce) {
              .architecture-flow-line,
              .architecture-flow-dot {
                animation: none;
              }
            }
          `}</style>
        </defs>

        <rect width={layout.width} height={layout.height} fill="url(#architecture-backdrop)" />
        <circle cx="1040" cy="88" r="190" fill="#1d4ed8" opacity="0.12" />
        <circle cx="132" cy={layout.height - 90} r="210" fill="#7c3aed" opacity="0.12" />

        {layout.renderedLayers.map(({ height, layer, width, x, y }) => {
          const style = layerStyles[layer];
          return (
            <g key={layer}>
              <rect
                x={x}
                y={y}
                width={width}
                height={height}
                rx="24"
                fill={style.fill}
                opacity="0.34"
                stroke={style.accent}
                strokeOpacity="0.24"
              />
              <text x="48" y={y + 27} fill={style.accent} fontSize="15" fontWeight="700">
                {layerLabels[layer]}
              </text>
            </g>
          );
        })}

        {topologyEdges.map((edge: TopologyEdge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) {
            return null;
          }
          const flow = flowStyles[edge.flowId];
          const pathId = `architecture-edge-${edge.from}-${edge.to}-${index}`;
          const path = edgePath(from, to, index);
          return (
            <g key={pathId} opacity="0.9">
              <path d={path} fill="none" stroke="#020617" strokeLinecap="round" strokeWidth="10" opacity="0.58" />
              <path
                className="architecture-flow-line"
                d={path}
                fill="none"
                stroke={flow.color}
                strokeDasharray="14 22"
                strokeLinecap="round"
                strokeWidth="4"
                style={{ animationDuration: flow.duration }}
              />
              <path id={pathId} d={path} fill="none" stroke="transparent" />
              <circle className="architecture-flow-dot" fill={flow.color} filter="url(#architecture-glow)">
                <animateMotion dur={flow.duration} repeatCount="indefinite" rotate="auto">
                  <mpath href={`#${pathId}`} />
                </animateMotion>
              </circle>
            </g>
          );
        })}

        {Array.from(positions.values()).map((node) => {
          const style = layerStyles[node.layer];
          const isSelected = selectedNodeId === node.id;
          const labelLines = wrapLabel(node.label);
          const labelStartY = 42 - (labelLines.length - 1) * 8;
          return (
            <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
              <rect
                width={node.width}
                height={node.height}
                rx="18"
                fill="#0f172a"
                stroke={isSelected ? '#ffffff' : style.accent}
                strokeWidth={isSelected ? 4 : 2}
                filter={isSelected ? 'url(#architecture-glow)' : undefined}
              />
              <rect x="12" y="12" width="10" height="68" rx="5" fill={style.accent} />
              <text x="34" y={labelStartY} fill="#ffffff" fontSize="14" fontWeight="800">
                {labelLines.map((line, lineIndex) => (
                  <tspan key={line} x="34" dy={lineIndex === 0 ? 0 : 16}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text x="34" y="76" fill="#cbd5e1" fontSize="11" fontWeight="600">
                {node.vendorService}
              </text>
              <foreignObject x="0" y="0" width={node.width} height={node.height}>
                <button
                  type="button"
                  aria-label={`Show details for ${node.label}`}
                  className="h-full w-full cursor-pointer rounded-[18px] bg-transparent"
                  onClick={() => onSelectNode?.(node)}
                />
              </foreignObject>
            </g>
          );
        })}

        <g transform="translate(34 24)">
          <text fill="#f8fafc" fontSize="25" fontWeight="900">
            Static demo topology · animated request flows
          </text>
          <text y="28" fill="#94a3b8" fontSize="14" fontWeight="600">
            Grey status badges on the page mean unknown; static-only nodes are labelled honestly.
          </text>
        </g>
      </svg>
    </div>
  );
}
