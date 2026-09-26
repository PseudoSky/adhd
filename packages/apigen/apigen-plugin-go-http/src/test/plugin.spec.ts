import { describe, it, expect } from 'vitest';
import { goHttpPlugin } from '../lib/plugin';

describe('go-http plugin — v2 shape', () => {
  it('has a string id', () => {
    expect(typeof goHttpPlugin.id).toBe('string');
    expect(goHttpPlugin.id).toBe('go-http');
  });

  it('declares a capabilities object', () => {
    // capabilities must be a non-null object — the v2 contract requires it
    expect(goHttpPlugin.capabilities).toBeDefined();
    expect(typeof goHttpPlugin.capabilities).toBe('object');
    expect(goHttpPlugin.capabilities).not.toBeNull();
  });

  it('capabilities.target declares the correct name and generate function', () => {
    const { target } = goHttpPlugin.capabilities;
    // target capability is required for a code-generating / server plugin
    expect(target).toBeDefined();
    expect(target!.name).toBe('go-http');
    expect(typeof target!.generate).toBe('function');
  });

  it('capabilities.target.generate returns a File array', () => {
    const { target } = goHttpPlugin.capabilities;
    // drive the real generate() — it must return an array (may be empty stub)
    const result = target!.generate(
      { operations: [], host: 'ts', namespace: 'test' },
      {}
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it('capabilities.layer declares a layer function', () => {
    const { layer } = goHttpPlugin.capabilities;
    // layer capability skeleton must exist and expose a layer() function
    expect(layer).toBeDefined();
    expect(typeof layer!.layer).toBe('function');
  });

  it('capabilities.target has no serve (generate-only plugin)', () => {
    // generate-only plugins omit serve; this test fails if serve is added
    // accidentally, keeping the shape honest
    expect(goHttpPlugin.capabilities.target!.serve).toBeUndefined();
  });
});
