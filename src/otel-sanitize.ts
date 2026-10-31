/** Structural span type: keeps the published typings free of optional OpenTelemetry packages. */
type SpanLike = { attributes: Record<string, unknown> };

const URL_ATTRIBUTES = ['url.full', 'http.url'] as const;
const PATH_ATTRIBUTES = ['http.target', 'url.path'] as const;

/** Remove query, fragment and credentials from a URL or request target. */
export function stripUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/[?#].*$/, '');
  }
}

/** Copy of `span` without query strings in its URL attributes (the span itself stays untouched). */
export function sanitizeSpan<T extends SpanLike>(span: T): T {
  const attributes: Record<string, unknown> = { ...span.attributes };
  let changed = false;
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') {
      const clean = stripUrl(value);
      if (clean !== value) {
        attributes[key] = clean;
        changed = true;
      }
    }
  }
  for (const key of PATH_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string' && /[?#]/.test(value)) {
      attributes[key] = value.replace(/[?#].*$/, '');
      changed = true;
    }
  }
  if ('url.query' in attributes) {
    delete attributes['url.query'];
    changed = true;
  }
  if (!changed) return span;
  return Object.create(span, { attributes: { value: attributes, enumerable: true } }) as T;
}

