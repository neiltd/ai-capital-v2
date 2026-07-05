import { requireKey } from '../../lib/env.ts';
import { logger } from '../../lib/logger.ts';
import { fetchWithTimeout, SourceFetchError, type SourceClient } from './base.client.ts';

// Raw shape returned by NewsAPI /v2/everything
export interface NewsAPIArticle {
  source: { id: string | null; name: string };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

export interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsAPIArticle[];
}

// Topics pulled on each run — geopolitical focus
const QUERIES = [
  'conflict OR war OR attack OR bombing',
  'protest OR riot OR coup OR sanctions',
  'oil supply OR energy crisis OR pipeline',
];

export class NewsAPIClient implements SourceClient {
  readonly name = 'newsapi';

  fetch(since?: string): Promise<unknown> {
    const key = requireKey('NEWSAPI_KEY', this.name);
    return this.fetchAll(key, since);
  }

  private async fetchAll(key: string, since?: string): Promise<NewsAPIResponse> {
    const from = since ?? new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
    const allArticles: NewsAPIArticle[] = [];

    for (const q of QUERIES) {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', q);
      url.searchParams.set('from', from);
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', '20');
      url.searchParams.set('apiKey', key);

      logger.info(this.name, `Fetching query: "${q}" since ${from}`);
      const res = await fetchWithTimeout(url.toString());

      if (!res.ok) {
        const body = await res.text();
        throw new SourceFetchError(this.name, `HTTP ${res.status}: ${body}`, res.status);
      }

      const data = (await res.json()) as NewsAPIResponse;
      if (data.status !== 'ok') {
        throw new SourceFetchError(this.name, `API error: ${JSON.stringify(data)}`);
      }

      logger.info(this.name, `Got ${data.articles.length} articles for query "${q}"`);
      allArticles.push(...data.articles);
    }

    return { status: 'ok', totalResults: allArticles.length, articles: allArticles };
  }
}
