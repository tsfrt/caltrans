import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { paneVisibilityClass } from '../../App';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { ArchitecturePage } from './ArchitecturePage';

const normalize = (markup: string) => markup.replace(/<!--.*?-->/g, '');

describe('Architecture visual', () => {
  it('renders the animated SVG topology without live data', () => {
    const markup = normalize(renderToStaticMarkup(<ArchitectureDiagram selectedNodeId="browser-client" />));

    expect(markup).toContain('California Traffic What-If architecture topology');
    expect(markup).toContain('architecture-flow-line');
    expect(markup).toContain('prefers-reduced-motion: reduce');
    expect(markup).toContain('Browser map client');
  });

  it('renders honest node details and unknown status on the page', () => {
    const markup = normalize(renderToStaticMarkup(<ArchitecturePage />));

    expect(markup).toContain('What-If platform topology');
    expect(markup).toContain('Unknown status');
    expect(markup).toContain('What-if run (client-side mock)');
    expect(markup).toContain('Spark Declarative Pipeline (not deployed from repo)');
  });

  it('switches tabs by hiding panes instead of unmounting them', () => {
    expect(paneVisibilityClass('map', 'map')).toBe('block');
    expect(paneVisibilityClass('map', 'architecture')).toBe('hidden');
    expect(paneVisibilityClass('architecture', 'map')).toBe('hidden');
    expect(paneVisibilityClass('architecture', 'architecture')).toBe('block');
  });
});
