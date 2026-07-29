import { describe, expect, it } from 'vitest';

import { architectureLayoutConfig, buildLayout, getRenderedLayers } from './ArchitectureDiagram';
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

  it('does not render empty layer bands', () => {
    const renderedLayers = getRenderedLayers(topologyNodes);

    for (const renderedLayer of renderedLayers) {
      expect(renderedLayer.nodes.length).toBeGreaterThan(0);
    }
  });

  it('positions node boxes without overlaps and with same-row gutters', () => {
    const layout = buildLayout(topologyNodes);
    const nodes = Array.from(layout.positioned.values());

    for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
      for (let toIndex = fromIndex + 1; toIndex < nodes.length; toIndex += 1) {
        const from = nodes[fromIndex];
        const to = nodes[toIndex];
        const overlapsHorizontally = from.x < to.x + to.width && to.x < from.x + from.width;
        const overlapsVertically = from.y < to.y + to.height && to.y < from.y + from.height;

        expect(overlapsHorizontally && overlapsVertically).toBe(false);
      }
    }

    const rowKeys = new Set(nodes.map((node) => `${node.layer}:${node.row}`));
    for (const rowKey of rowKeys) {
      const rowNodes = nodes
        .filter((node) => `${node.layer}:${node.row}` === rowKey)
        .sort((left, right) => left.x - right.x);

      for (let index = 0; index < rowNodes.length - 1; index += 1) {
        const gutter = rowNodes[index + 1].x - (rowNodes[index].x + rowNodes[index].width);

        expect(gutter).toBeGreaterThanOrEqual(architectureLayoutConfig.minHorizontalGutter);
      }
    }
  });

  it('keeps every node box inside the computed SVG bounds', () => {
    const layout = buildLayout(topologyNodes);

    for (const node of layout.positioned.values()) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });
});
