import { describe, expect, it } from 'vitest';

import { topologyEdges, topologyNodes } from './topology';

describe('architecture topology invariants', () => {
  it('has unique node ids', () => {
    const ids = topologyNodes.map((node) => node.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('ensures every edge references existing nodes', () => {
    const ids = new Set(topologyNodes.map((node) => node.id));

    for (const edge of topologyEdges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it('ensures every node has layer and evidence', () => {
    for (const node of topologyNodes) {
      expect(node.layer).toBeTruthy();
      expect(node.evidence).toMatch(/^[^\s]+:\d+$/);
    }
  });

  it('keeps SDP pipeline honestly labeled as not deployed', () => {
    const sdpNode = topologyNodes.find((node) => node.id === 'sdp-pipeline-not-deployed');

    expect(sdpNode).toBeDefined();
    expect(sdpNode?.liveness).toBe('static-only');
    expect(sdpNode?.honestNote?.toLowerCase()).toContain('not deploy');
  });

  it('keeps scenario run honestly labeled as client mock and DBSQL engine unrouted', () => {
    const scenarioMockNode = topologyNodes.find((node) => node.id === 'scenario-client-mock');
    const dbsqlScenarioNode = topologyNodes.find(
      (node) => node.id === 'dbsql-scenario-engine-unrouted',
    );
    const scenarioEdge = topologyEdges.find(
      (edge) => edge.from === 'scenario-client-mock' && edge.to === 'dbsql-scenario-engine-unrouted',
    );

    expect(scenarioMockNode).toBeDefined();
    expect(scenarioMockNode?.liveness).toBe('static-only');
    expect(scenarioMockNode?.description).toContain('applyMockScenario');
    expect(scenarioMockNode?.honestNote?.toLowerCase()).toContain('mock');

    expect(dbsqlScenarioNode).toBeDefined();
    expect(dbsqlScenarioNode?.liveness).toBe('static-only');
    expect(dbsqlScenarioNode?.honestNote?.toLowerCase()).toContain('unreachable');

    expect(scenarioEdge).toBeDefined();
    expect(scenarioEdge?.flowId).toBe('scenario-whatif-run');
  });
});
