import { useMemo, useState } from 'react';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import type { TopologyNode } from './topology';
import { topologyNodes } from './topology';

function LivenessLabel({ node }: { node: TopologyNode }) {
  const label = node.liveness === 'live-capable' ? 'Live-capable code path' : 'Static-only / not active';
  return (
    <span className="rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
      {label}
    </span>
  );
}

function UnknownStatusBadge() {
  return (
    <span className="rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
      Unknown status
    </span>
  );
}

type NodeDetailPanelProps = {
  node: TopologyNode;
};

function NodeDetailPanel({ node }: NodeDetailPanelProps) {
  return (
    <aside className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <UnknownStatusBadge />
        <LivenessLabel node={node} />
      </div>
      <h2 className="mt-4 text-xl font-semibold text-foreground">{node.label}</h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">{node.vendorService}</p>
      <p className="mt-4 text-sm leading-6 text-foreground">{node.description}</p>
      {node.honestNote ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {node.honestNote}
        </div>
      ) : null}
      <dl className="mt-5 space-y-3 text-sm">
        <div>
          <dt className="font-semibold text-foreground">Layer</dt>
          <dd className="text-muted-foreground">{node.layer}</dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">Evidence</dt>
          <dd className="text-muted-foreground">{node.evidence}</dd>
        </div>
      </dl>
    </aside>
  );
}

export function ArchitecturePage() {
  const [selectedNodeId, setSelectedNodeId] = useState('browser-client');
  const selectedNode = useMemo(
    () => topologyNodes.find((node) => node.id === selectedNodeId) ?? topologyNodes[0],
    [selectedNodeId],
  );

  return (
    <section className="min-h-full rounded-2xl bg-background text-foreground">
      <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Architecture
          </p>
          <h1 className="text-2xl font-bold text-foreground md:text-3xl">What-If platform topology</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Static, demo-safe topology for the Caltrans what-if app. Animated paths show request flows;
            status is intentionally grey and unknown until live wiring lands in a later chunk.
          </p>
        </div>
        <div className="rounded-full border bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
          Renders without live data
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ArchitectureDiagram selectedNodeId={selectedNode.id} onSelectNode={(node) => setSelectedNodeId(node.id)} />
        <NodeDetailPanel node={selectedNode} />
      </div>
    </section>
  );
}
