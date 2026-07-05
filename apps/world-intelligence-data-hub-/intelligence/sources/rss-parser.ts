import { XMLParser } from 'fast-xml-parser';

// ── Output types ──────────────────────────────────────────────────────────────

export type FeedFormat = 'rss' | 'rss1' | 'atom';

export interface RawFeedItem {
  title?:       string;
  link?:        string;
  description?: string;  // plain text, HTML stripped
  published_at?: string; // ISO datetime, best-effort
  author?:      string;
  tags:         string[];
  guid?:        string;
}

export interface ParsedFeed {
  format:       FeedFormat;
  feed_title?:  string;
  items:        RawFeedItem[];
}

// ── HTML entity + tag stripping ───────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—',
  '&ndash;': '–', '&hellip;': '…', '&ldquo;': '"', '&rdquo;': '"',
};

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => HTML_ENTITIES[m] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Date coercion ─────────────────────────────────────────────────────────────

function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const d = new Date(raw.trim());
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch {
    return undefined;
  }
}

// ── Value extraction from fast-xml-parser nodes ───────────────────────────────
// fast-xml-parser may return strings, objects with #text, or CDATA objects.

function text(node: unknown): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string')  return node.trim() || undefined;
  if (typeof node === 'number')  return String(node);
  if (typeof node === 'boolean') return undefined;
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    // CDATA sections
    if (o['__cdata'] !== undefined) return text(o['__cdata']);
    // Text node
    if (o['#text'] !== undefined)   return text(o['#text']);
    // Atom link has href attribute
    if (o['@_href'] !== undefined)  return text(o['@_href']);
  }
  return undefined;
}

function cats(node: unknown): string[] {
  if (!node) return [];
  const arr: unknown[] = Array.isArray(node) ? node : [node];
  return arr
    .map(c => text(c) ?? text((c as Record<string, unknown>)?.['@_term']) ?? '')
    .map(s => s.trim())
    .filter(Boolean);
}

// ── XML parser instance ───────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  textNodeName:        '#text',
  cdataPropName:       '__cdata',
  parseTagValue:       false,
  trimValues:          true,
  isArray: name => ['item', 'entry', 'category'].includes(name),
});

// ── RSS 2.0 parser ────────────────────────────────────────────────────────────

function parseRss(doc: Record<string, unknown>): ParsedFeed {
  const channel = (doc['rss'] as Record<string, unknown>)?.['channel'] as Record<string, unknown> ?? {};
  const items   = (channel['item'] ?? []) as Record<string, unknown>[];

  return {
    format:     'rss',
    feed_title: text(channel['title']),
    items: items.map(item => {
      const rawTitle = text(item['title']);
      return {
        // Strip HTML from title — some RSS feeds embed <a href> tags in title fields
        title:        rawTitle ? stripHtml(rawTitle) : undefined,
        link:         text(item['link']),
        description:  text(item['description']) ? stripHtml(text(item['description'])!) : undefined,
        published_at: toIso(text(item['pubDate']) ?? text(item['dc:date'])),
        author:       text(item['author']) ?? text(item['dc:creator']),
        tags:         cats(item['category']),
        guid:         text(typeof item['guid'] === 'object'
                        ? (item['guid'] as Record<string, unknown>)['#text']
                        : item['guid']),
      };
    }),
  };
}

// ── Atom 1.0 parser ───────────────────────────────────────────────────────────

function parseAtom(doc: Record<string, unknown>): ParsedFeed {
  const feed    = doc['feed'] as Record<string, unknown> ?? {};
  const entries = (feed['entry'] ?? []) as Record<string, unknown>[];

  return {
    format:     'atom',
    feed_title: text(feed['title']),
    items: entries.map(entry => {
      const linkNode = entry['link'];
      const link = Array.isArray(linkNode)
        ? text((linkNode as unknown[]).find(l =>
            (l as Record<string, unknown>)['@_rel'] === 'alternate' ||
            (l as Record<string, unknown>)['@_rel'] === undefined
          )) ?? text((linkNode as unknown[])[0])
        : text(linkNode);

      const summary = text(entry['summary']) ?? text(entry['content']);
      const author  = entry['author'] as Record<string, unknown> | undefined;

      const rawTitle = text(entry['title']);
      return {
        title:        rawTitle ? stripHtml(rawTitle) : undefined,
        link,
        description:  summary ? stripHtml(summary) : undefined,
        published_at: toIso(text(entry['published']) ?? text(entry['updated'])),
        author:       author ? text(author['name']) : text(entry['author']),
        tags:         cats(entry['category']),
        guid:         text(entry['id']),
      };
    }),
  };
}

// ── RSS 1.0 / RDF parser ──────────────────────────────────────────────────────
// RSS 1.0 uses <rdf:RDF> root. fast-xml-parser strips the namespace prefix
// when removeNSPrefix is true, but we're not using that option here.
// The key lookup is 'rdf:RDF' or just 'RDF' depending on parser settings.

function parseRdf(doc: Record<string, unknown>): ParsedFeed {
  // fast-xml-parser preserves namespace prefix in key name
  const rdf = (doc['rdf:RDF'] ?? doc['RDF']) as Record<string, unknown> | undefined;
  if (!rdf) throw new Error('RDF root not found');

  const channel = rdf['channel'] as Record<string, unknown> | undefined ?? {};
  const items   = (rdf['item'] ?? []) as Record<string, unknown>[];

  return {
    format:     'rss1',
    feed_title: text(channel['title']),
    items: items.map(item => ({
      title:        text(item['title']),
      link:         text(item['link']),
      description:  text(item['description']) ? stripHtml(text(item['description'])!) : undefined,
      published_at: toIso(text(item['dc:date']) ?? text(item['pubDate'])),
      author:       text(item['dc:creator']) ?? text(item['author']),
      tags:         cats(item['dc:subject'] ?? item['category']),
      guid:         text(item['rdf:about'] ?? item['link']),
    })),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseFeed(xmlText: string): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xmlText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`XML parse failed: ${(err as Error).message}`);
  }

  if (doc['rss'])              return parseRss(doc);
  if (doc['feed'])             return parseAtom(doc);
  if (doc['rdf:RDF'] || doc['RDF']) return parseRdf(doc);

  throw new Error('Unrecognized feed format — expected <rss>, <feed>, or <rdf:RDF> root element');
}
