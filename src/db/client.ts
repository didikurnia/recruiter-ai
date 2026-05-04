import { Pool } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env'
import { logger } from '../logger'

export const pool = new Pool({ connectionString: env.DATABASE_URL })

export async function runMigrations(): Promise<void> {
  // pgvector is optional — app still works without it (job-lookup falls back gracefully)
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    logger.info({ event: 'pgvector_extension_enabled' })
  } catch (err) {
    logger.warn({ event: 'pgvector_extension_unavailable', err: (err as Error).message,
      hint: 'Install pgvector on the PostgreSQL server or use the pgvector/pgvector Docker image' })
  }

  const migrationsDir = join(import.meta.dir, 'migrations')

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    await pool.query(sql)
    logger.info({ event: 'migration_applied', file })
  }
}
