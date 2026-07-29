import type { TopologyEdge, TopologyFlowId, TopologyLayer, TopologyNode } from './topology';
import { topologyEdges, topologyNodes } from './topology';

const layerOrder: TopologyLayer[] = ['ingest', 'storage+governance', 'compute', 'serving+AI', 'app'];

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

type PositionedNode = TopologyNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

const width = 1180;
const height = 680;
const nodeWidth = 190;
const nodeHeight = 82;
const layerTop = 96;
const layerGap = 124;
const laneLeft = 54;
const laneWidth = 1072;

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

function buildLayout(nodes: TopologyNode[]) {
  const byLayer = new Map<TopologyLayer, TopologyNode[]>(layerOrder.map((layer) => [layer, []]));
  for (const node of nodes) {
    byLayer.get(node.layer)?.push(node);
  }

  const positioned = new Map<string, PositionedNode>();
  layerOrder.forEach((layer, layerIndex) => {
    const layerNodes = byLayer.get(layer) ?? [];
    const spacing = laneWidth / (layerNodes.length + 1);
    layerNodes.forEach((node, nodeIndex) => {
      positioned.set(node.id, {
        ...node,
        x: laneLeft + spacing * (nodeIndex + 1) - nodeWidth / 2,
        y: layerTop + layerGap * layerIndex,
        width: nodeWidth,
        height: nodeHeight,
      });
    });
  });

  return positioned;
}

function edgePath(from: PositionedNode, to: PositionedNode, edgeIndex: number) {
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height / 2;
  const bow = (edgeIndex % 3) * 18 - 18;
  const midY = (startY + endY) / 2 + bow;

  return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
}

type ArchitectureDiagramProps = {
  selectedNodeId?: string;
  onSelectNode?: (node: TopologyNode) => void;
};

export function ArchitectureDiagram({ selectedNodeId, onSelectNode }: ArchitectureDiagramProps) {
  const positions = buildLayout(topologyNodes);

  return (
    <div className="overflow-hidden rounded-2xl border bg-slate-950 text-white shadow-2xl shadow-slate-950/30">
      <svg
        role="img"
        aria-label="California Traffic What-If architecture topology with animated request flows"
        className="h-auto w-full"
        viewBox={`0 0 ${width} ${height}`}
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

        <rect width={width} height={height} fill="url(#architecture-backdrop)" />
        <circle cx="1040" cy="88" r="190" fill="#1d4ed8" opacity="0.12" />
        <circle cx="132" cy="590" r="210" fill="#7c3aed" opacity="0.12" />

        {layerOrder.map((layer, index) => {
          const style = layerStyles[layer];
          const y = layerTop + layerGap * index - 20;
          return (
            <g key={layer}>
              <rect
                x="28"
                y={y}
                width="1124"
                height="108"
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
              <rect x="12" y="12" width="10" height="58" rx="5" fill={style.accent} />
              <text x="32" y="29" fill="#ffffff" fontSize="14" fontWeight="800">
                {labelLines.map((line, lineIndex) => (
                  <tspan key={line} x="32" dy={lineIndex === 0 ? 0 : 16}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text x="32" y="68" fill="#cbd5e1" fontSize="11" fontWeight="600">
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
