import { z } from 'zod'

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  ADMIN_TELEGRAM_CHAT_IDS: z.string().min(1, 'ADMIN_TELEGRAM_CHAT_IDS is required'),
  ADMIN_PASSWORD: z.string().min(1, 'ADMIN_PASSWORD is required'),
  RECRUITER_TELEGRAM_CHAT_ID: z.string().min(1, 'RECRUITER_TELEGRAM_CHAT_ID is required'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().min(1, 'GOOGLE_SERVICE_ACCOUNT_EMAIL is required'),
  GOOGLE_PRIVATE_KEY: z.string().min(1, 'GOOGLE_PRIVATE_KEY is required'),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().min(1, 'GOOGLE_SHEETS_SPREADSHEET_ID is required'),
  GOOGLE_SHEETS_SHEET_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_DRIVE_FOLDER_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_OAUTH_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  CALENDLY_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  CALENDLY_WEBHOOK_SIGNING_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  GOOGLE_JOBS_SPREADSHEET_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GOOGLE_JOBS_SHEET_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  NODE_ENV: z.preprocess(
    (v) => (v === 'test' ? 'development' : v),
    z.enum(['development', 'production']).default('development')
  ),
})

const parsed = envSchema.safeParse(Bun.env)

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
  console.error('❌ Missing or invalid environment variables:\n' + missing.join('\n'))
  console.error('\nCopy .env.example to .env and fill in the required values.')
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env

/**
 * Returns the Google service account private key with proper PEM newlines.
 * Handles all formats seen in .env files and K8s secrets:
 *   - Surrounding quotes added by some secret managers
 *   - Double-escaped \\n (JSON-within-JSON or some K8s secret tools)
 *   - Single-escaped \n (standard JSON / kubectl --from-literal)
 *   - Actual newlines (Bun already processed quoted string, or secret from file)
 *   - Windows CRLF line endings
 */
export function parseGoogleKey(): string {
  let raw = env.GOOGLE_PRIVATE_KEY

  // Strip surrounding quotes added by some secret managers or kubectl
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1)
  }

  // Normalize line endings: handle double-escaped first, then single-escaped, then CRLF
  raw = raw
    .replace(/\\\\n/g, '\n')   // double-escaped \\n → newline
    .replace(/\\n/g, '\n')     // single-escaped \n → newline
    .replace(/\r\n/g, '\n')    // Windows CRLF → LF
    .replace(/\r/g, '\n')      // stray CR → LF

  return raw.trim()
}
