import { describe, expect, it } from 'vitest';
import config from '../nginx.server.conf?raw';

describe('production static-file cache policy', () => {
  it('returns missing hashed assets as 404 instead of the SPA document', () => {
    const assets = config.match(/location\s+\^~\s+\/assets\/\s*\{([^}]*)\}/)?.[1];
    expect(assets).toBeDefined();
    expect(assets).toMatch(/try_files\s+\$uri\s+=404\s*;/);
    expect(assets).not.toContain('/index.html');
  });

  it('caches existing fingerprinted assets without caching 404 responses as immutable', () => {
    const assets = config.match(/location\s+\^~\s+\/assets\/\s*\{([^}]*)\}/)?.[1];
    expect(assets).toMatch(/add_header\s+Cache-Control\s+"public, max-age=31536000, immutable"\s*;/);
    expect(assets).not.toMatch(/immutable"\s+always/);
  });

  it('does not cache either the direct HTML document or SPA routes', () => {
    const index = config.match(/location\s+=\s+\/index\.html\s*\{([^}]*)\}/)?.[1];
    const routes = config.match(/location\s+\/\s*\{([^}]*)\}/)?.[1];
    for (const block of [index, routes]) {
      expect(block).toMatch(/add_header\s+Cache-Control\s+"no-store, no-cache, must-revalidate"\s+always\s*;/);
    }
    expect(routes).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/);
  });
});
