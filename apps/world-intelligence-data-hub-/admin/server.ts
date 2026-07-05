import express, { type Request, type Response, type NextFunction } from 'express';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import { existsSync }     from 'fs';
import { timingSafeEqual } from 'crypto';
import { extractHumanIntel }   from '../intelligence/human/extractor.ts';
import { analyseEvent }        from '../intelligence/human/analyser.ts';
import { synthesiseBrief }     from '../intelligence/human/brief-synthesizer.ts';
import { appendHumanRecord, loadHumanStore } from '../intelligence/human/store.ts';
import {
  loadAnalysisStore,
  upsertAnalysis,
  loadBriefs,
  upsertBrief,
} from '../intelligence/human/analysis-store.ts';
import { runExports }  from '../intelligence/exports/run-exports.ts';
import type { EventAnalysis, CountryBrief, AdminHumanIntelRecord } from './types.ts';
import type { HumanIntelRecord } from '../intelligence/human/store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.error('ADMIN_API_KEY is not set — refusing to start admin server without auth');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const expected = Buffer.from(ADMIN_API_KEY as string);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// ── API ───────────────────────────────────────────────────────────────────────

app.use('/api', requireAuth);

app.post('/api/analyse', async (req: Request, res: Response) => {
  try {
    const { rawText, sourcePlatform, sourceUrl } = req.body as {
      rawText:        string;
      sourcePlatform: HumanIntelRecord['source_platform'];
      sourceUrl?:     string;
    };
    const VALID_PLATFORMS = ['tiktok', 'youtube', 'podcast', 'web', 'other'] as const;
    if (sourcePlatform && !VALID_PLATFORMS.includes(sourcePlatform)) {
      res.status(400).json({ error: 'Invalid sourcePlatform' }); return;
    }
    if (!rawText?.trim() || !sourcePlatform) {
      res.status(400).json({ error: 'rawText and sourcePlatform are required' });
      return;
    }
    const record   = await extractHumanIntel({ rawText, sourcePlatform, sourceUrl });
    const analysis = await analyseEvent(record);
    res.json({ record, analysis });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/publish', async (req: Request, res: Response) => {
  try {
    const { record, analysis } = req.body as {
      record:   AdminHumanIntelRecord;
      analysis: EventAnalysis;
    };
    appendHumanRecord(record as unknown as HumanIntelRecord);
    upsertAnalysis(analysis);
    const today = new Date().toISOString().slice(0, 10);
    try { runExports(today); } catch { /* non-fatal — export may fail if no pipeline events */ }
    res.json({ success: true, id: record.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/brief/refresh', async (req: Request, res: Response) => {
  try {
    const { iso3 } = req.body as { iso3: string };
    if (!iso3?.trim()) { res.status(400).json({ error: 'iso3 is required' }); return; }
    const brief = await synthesiseBrief(iso3.trim().toUpperCase());
    res.json({ brief });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/brief/publish', async (req: Request, res: Response) => {
  try {
    const { brief } = req.body as { brief: CountryBrief };
    upsertBrief(brief);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/briefs', (_req: Request, res: Response) => {
  res.json({ briefs: loadBriefs() });
});

app.get('/api/records', (_req: Request, res: Response) => {
  const records  = loadHumanStore();
  const analyses = loadAnalysisStore();
  const aMap     = new Map(analyses.map(a => [a.event_id, a]));
  res.json({ records: records.map(r => ({ ...r, analysis: aMap.get(r.id) })) });
});

// ── Static (production build) ─────────────────────────────────────────────────

const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/{*splat}', (_req: Request, res: Response) => {
    res.sendFile(join(distPath, 'index.html'));
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.send(
      '<body style="background:#0a0c10;color:#c9d1d9;font-family:monospace;padding:2rem">' +
      '<p>Build the client first: <code>npm run admin:build</code></p>' +
      '<p>Or dev mode: run <code>npm run admin:api</code> + <code>npm run admin:client</code> in two terminals</p>' +
      '</body>'
    );
  });
}

const PORT = Number(process.env.ADMIN_PORT ?? 3001);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nAdmin panel → http://localhost:${PORT}`);
});
