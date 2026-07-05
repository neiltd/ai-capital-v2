import { join } from 'path';

const ROOT = import.meta.dirname ? join(import.meta.dirname, '..') : process.cwd();

export const PATHS = {
  root: ROOT,

  store: {
    root:         join(ROOT, 'store'),
    rawRoot:      join(ROOT, 'store', 'raw'),
    normalized:   join(ROOT, 'store', 'normalized'),
    validated:    join(ROOT, 'store', 'validated'),
    dedupIndex:   join(ROOT, 'store', 'dedup-index.json'),
    cursors:      join(ROOT, 'store', 'source-cursors.json'),

    timeseries: {
      root:        join(ROOT, 'store', 'timeseries'),
      commodities: join(ROOT, 'store', 'timeseries', 'commodities'),
      structural:  join(ROOT, 'store', 'timeseries', 'structural'),
    },
  },

  quota: {
    root:  join(ROOT, 'quota'),
    state: join(ROOT, 'quota', 'state.json'),
  },

  exports: {
    root:         join(ROOT, 'exports'),
    manifest:     join(ROOT, 'exports', 'manifest.json'),
    worldMap:     join(ROOT, 'exports', 'world-map'),
    oilProject:   join(ROOT, 'exports', 'oil-project'),
    stockProject: join(ROOT, 'exports', 'stock-project'),

    timeseries: {
      oilPrices: join(ROOT, 'exports', 'oil-project', 'oil-prices.json'),
      gasPrices: join(ROOT, 'exports', 'oil-project', 'gas-prices.json'),
      lngPrices: join(ROOT, 'exports', 'oil-project', 'lng-prices.json'),
    },
  },

  runs: join(ROOT, 'runs'),

  intelligence: {
    root:             join(ROOT, 'intelligence'),
    sources:          join(ROOT, 'intelligence', 'sources'),
    sourceHealth:     join(ROOT, 'intelligence', 'sources', 'source-health.json'),
    fingerprintIndex: join(ROOT, 'intelligence', 'sources', 'fingerprint-index.json'),
    rawArticles:      join(ROOT, 'intelligence', 'raw', 'articles'),     // raw snapshots
    outputArticles:   join(ROOT, 'intelligence', 'outputs', 'articles'), // normalized ArticleRecords
    outputEvents:     join(ROOT, 'intelligence', 'outputs', 'events'),   // extracted IntelligenceEvents
    articleEventMap:  join(ROOT, 'intelligence', 'outputs', 'events', 'article-event-map.json'),
    metrics:          join(ROOT, 'intelligence', 'metrics'),             // daily operational metrics (tracked in git)
    outputs:          join(ROOT, 'intelligence', 'outputs'),
    memory:           join(ROOT, 'intelligence', 'memory'),
    human: {
      root:          join(ROOT, 'intelligence', 'human'),
      store:         join(ROOT, 'intelligence', 'human', 'store.json'),
      inbox:         join(ROOT, 'intelligence', 'human', 'inbox.md'),
      analysisStore: join(ROOT, 'intelligence', 'human', 'analysis-store.json'),
      briefs:        join(ROOT, 'intelligence', 'human', 'briefs.json'),
    },
    twitter: {
      root:     join(ROOT, 'intelligence', 'twitter'),
      accounts: join(ROOT, 'intelligence', 'twitter', 'accounts.json'),
    },
  },

  admin: {
    root: join(ROOT, 'admin'),
    dist: join(ROOT, 'admin', 'dist'),
  },
} as const;
