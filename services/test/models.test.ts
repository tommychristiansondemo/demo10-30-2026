import { describe, expect, it } from 'vitest';
import { endpointFor, requestOptions, supportsAdaptive } from '../src/ai/models.js';

describe('model routing', () => {
  it('sends inference profiles to the runtime and bare IDs to Mantle', () => {
    expect(endpointFor('us.anthropic.claude-opus-4-6-v1')).toBe('runtime');
    expect(endpointFor('global.anthropic.claude-sonnet-4-6')).toBe('runtime');
    expect(endpointFor('anthropic.claude-opus-5-5')).toBe('mantle');
  });

  it('only enables adaptive thinking where supported', () => {
    expect(supportsAdaptive('us.anthropic.claude-opus-4-6-v1')).toBe(true);
    expect(supportsAdaptive('anthropic.claude-opus-5-5')).toBe(true);
    expect(supportsAdaptive('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(false);
    expect(requestOptions('us.anthropic.claude-haiku-4-5-20251001-v1:0', 'sys', 'medium')).not.toHaveProperty('thinking');
  });

  it('uses explicit cache breakpoints on the runtime and automatic caching on Mantle', () => {
    const runtime = requestOptions('us.anthropic.claude-opus-4-6-v1', 'sys', 'xhigh');
    expect(runtime).not.toHaveProperty('cache_control');
    expect(runtime.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(runtime.output_config?.effort).toBe('high'); // no xhigh before Opus 4.7

    const mantle = requestOptions('anthropic.claude-opus-5-5', 'sys', 'xhigh');
    expect(mantle.cache_control).toEqual({ type: 'ephemeral' });
    expect(mantle.output_config?.effort).toBe('xhigh');
  });
});
