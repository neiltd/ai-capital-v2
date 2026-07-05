import 'dotenv/config';
import { z } from 'zod';

// All keys are optional at load time.
// Clients check their own required key at fetch time and fail clearly if absent.
const EnvSchema = z.object({
  // NewsAPI
  NEWSAPI_KEY:       z.string().optional(),

  // ACLED (OAuth2 Resource Owner Password Credentials)
  ACLED_USERNAME:    z.string().optional(),
  ACLED_PASSWORD:    z.string().optional(),
  ACLED_TOKEN_URL:   z.string().url().optional().default('https://acleddata.com/oauth/token'),
  ACLED_API_BASE_URL: z.string().url().optional().default('https://acleddata.com/api/acled/read'),
  ACLED_CLIENT_ID:   z.string().optional().default('acled'),
  ACLED_SCOPE:       z.string().optional().default('authenticated'),

  // EIA
  EIA_KEY:           z.string().optional(),

  // UCDP (Uppsala Conflict Data Program) — token-based auth.
  // Request a free token by emailing mertcan.yilmaz@pcr.uu.se.
  // The client throws a soft "token not configured" if UCDP_TOKEN is unset.
  UCDP_TOKEN:        z.string().optional(),
  UCDP_API_BASE_URL: z.string().url().optional().default('https://ucdpapi.pcr.uu.se/api'),
  UCDP_DATASET_VERSION: z.string().optional().default('26.1'),

  // Anthropic (reporter-agent)
  ANTHROPIC_API_KEY: z.string().optional(),

  // Runtime
  DEBUG:             z.string().optional().default('false'),
  NODE_ENV:          z.string().optional().default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[ENV] Unexpected environment validation error:');
    result.error.issues.forEach(i => console.error(`  ${i.path.join('.')}: ${i.message}`));
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function requireKey(name: keyof Env, source: string): string {
  const val = env[name];
  if (!val) {
    throw new ConfigurationError(`${source} requires ${name} to be set in .env — add it to your .env file`);
  }
  return val;
}
