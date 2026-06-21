/** Recursive fallback schema builder for primitive, array, union, and anonymous object types. */
export function morphFallback(typeText: string, depth: number): Record<string, unknown> {
  if (depth > 6) return {}
  const t = typeText.trim()
  if (t === 'string') return { type: 'string' }
  if (t === 'number') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'null') return { type: 'null' }
  if (t === 'undefined') return { type: 'null' }
  if (t.endsWith('[]')) return { type: 'array', items: morphFallback(t.slice(0, -2), depth + 1) }
  if (t.includes('|')) {
    const variants = t.split('|').map(v => v.trim())
    // Check if all are string literals
    if (variants.every(v => v.startsWith("'"))) {
      return { type: 'string', enum: variants.map(v => v.replace(/'/g, '')) }
    }
    return { anyOf: variants.map(v => morphFallback(v, depth + 1)) }
  }
  // Anonymous object: { key: type; key2: type2 }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    const props: Record<string, unknown> = {}
    for (const part of inner.split(';').filter(Boolean)) {
      const [k, v] = part.split(':').map(s => s.trim())
      if (k && v) props[k.replace('?', '')] = morphFallback(v, depth + 1)
    }
    return { type: 'object', properties: props }
  }
  return {}  // unknown complex type — return empty schema
}
