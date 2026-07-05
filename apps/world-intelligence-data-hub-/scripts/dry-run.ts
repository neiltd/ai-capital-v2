// End-to-end dry run using synthetic data — no real API keys needed.
// npm run pipeline does the same with real clients.

import { QuotaTracker } from '../quota/quota-tracker.ts';
import { runPipeline, buildSourceVersions } from '../ingestion/pipelines/pipeline.ts';
import { runAllExports } from '../exports/exporter.ts';
import { writeRunManifest, writeExportManifest } from '../lib/manifest.ts';
import type { SourceClient } from '../ingestion/clients/base.client.ts';
import { SOURCE_NAMES, type SourceName } from '../lib/sources-config.ts';
import { logger } from '../lib/logger.ts';

const mockGDELT: SourceClient = {
  name: 'gdelt',
  async fetch() {
    return {
      articles: [
        {
          url: 'https://reuters.com/news/1', url_mobile: 'https://reuters.com/news/1',
          title: 'Iraqi forces repel militant attack near Mosul',
          seendate: '20260512T040000Z', socialimage: '', domain: 'reuters.com',
          language: 'English', sourcecountry: 'Iraq',
        },
        {
          url: 'https://bbc.com/news/2', url_mobile: 'https://bbc.com/news/2',
          title: 'Saudi Arabia announces oil production cuts',
          seendate: '20260512T060000Z', socialimage: '', domain: 'bbc.com',
          language: 'English', sourcecountry: 'Saudi Arabia',
        },
      ],
    };
  },
};

const mockACLED: SourceClient = {
  name: 'acled',
  async fetch() {
    return {
      status: 200, success: true, count: 1,
      data: [{
        event_id_cnty: 'IRQ7890', event_date: '2026-05-11', year: '2026',
        event_type: 'Battles', sub_event_type: 'Armed clash',
        actor1: 'Iraqi Army', actor2: 'Islamic State',
        country: 'Iraq', iso3: 'IRQ', region: 'Middle East',
        admin1: 'Nineveh', admin2: 'Mosul', location: 'Mosul',
        latitude: '36.34', longitude: '43.13', geo_precision: 1,
        source: 'AFP', notes: 'Soldiers repelled an ISIS offensive — 12 dead.', fatalities: 12,
      }],
    };
  },
};

const mockEIA: SourceClient = {
  name: 'eia',
  async fetch() {
    return {
      'spot-prices': {
        response: {
          total: 2, dateFormat: 'YYYY-MM-DD', frequency: 'daily',
          data: [
            {
              period: '2026-05-11', 'area-name': 'World', 'product-name': 'Crude Oil',
              'series-description': 'WTI Crude Oil Price', value: '82.45',
              units: 'Dollars per Barrel',
            },
            {
              period: '2026-05-11', 'area-name': 'World', 'product-name': 'Crude Oil',
              'series-description': 'Brent Crude Oil Price', value: '84.12',
              units: 'Dollars per Barrel',
            },
          ],
        },
      },
    };
  },
};

const mockUCDP: SourceClient = {
  name: 'ucdp',
  async fetch() {
    return {
      Result: [
        {
          id: 123456, year: 2026, type_of_violence: 1,
          conflict_name: 'Government of Iraq - Islamic State', dyad_name: 'IS - Iraq',
          side_a: 'Government of Iraq', side_b: 'Islamic State',
          date_start: '2026-05-11', date_end: '2026-05-11', date_prec: 1,
          best: 12, low: 10, high: 14,
          deaths_a: 3, deaths_b: 9, deaths_civilians: 0, deaths_unknown: 0,
          latitude: 36.34, longitude: 43.13, geom_wkt: null,
          country: 'Iraq', country_id: 645, region: 'Middle East',
          source_article: 'AFP wire report on the clash near Mosul.',
          source_office: 'AFP', source_date: '2026-05-11',
          source_headline: 'Iraqi forces repel militant attack near Mosul',
          source_original: null,
        },
      ],
      TotalCount: 1, TotalPages: 1, PageCount: 1, Page: 1,
      PreviousPageUrl: null, NextPageUrl: null,
    };
  },
};

const mockWorldBank: SourceClient = {
  name: 'worldbank',
  async fetch() {
    const meta = { page: 1, pages: 1, per_page: 100, total: 1 };
    return {
      gdp_usd: [[
        meta,
        [{
          indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' },
          country:   { id: 'SA', value: 'Saudi Arabia' },
          date: '2024', value: 1_100_000_000_000, decimal: 0,
        }],
      ]],
    };
  },
};

async function main(): Promise<void> {
  logger.info('dry-run', '══════════════════════════════════════');
  logger.info('dry-run', ' Dry run — synthetic data, no API keys');
  logger.info('dry-run', '══════════════════════════════════════');

  const quota = new QuotaTracker();

  // Keyed by the canonical SOURCE_NAMES so this list can't silently drift
  // from run.ts's real client set again — TypeScript will error here if a
  // source is added/removed from SOURCE_NAMES without a matching mock.
  const mocks: Record<SourceName, SourceClient> = {
    gdelt:     mockGDELT,
    acled:     mockACLED,
    ucdp:      mockUCDP,
    eia:       mockEIA,
    worldbank: mockWorldBank,
  };
  const manifest = await runPipeline(SOURCE_NAMES.map(name => mocks[name]), quota);

  const { versions, stale } = buildSourceVersions(quota, manifest.sources);
  runAllExports(versions, stale);
  writeExportManifest();
  manifest.exported = true;
  writeRunManifest(manifest);

  logger.info('dry-run', 'Complete. Check exports/ and runs/ for output.');
}

main().catch(err => {
  logger.error('dry-run', 'Fatal error', { error: String(err) });
  process.exit(1);
});
