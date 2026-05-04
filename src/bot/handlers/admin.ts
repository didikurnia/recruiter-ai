/**
 * Admin area — password-protected commands accessible via Telegram.
 *
 * Flow:
 *   /admin <password>  → authenticates, shows admin menu
 *   /sync              → re-seed knowledge base from Google Sheets
 *   /stats             → show bot statistics
 *   /logout            → exit admin mode
 */
import { InlineKeyboard } from 'grammy'
import { env, parseGoogleKey } from '../../config/env'
import { logger } from '../../logger'
import type { BotContext } from '../middleware/session'

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function handleAdminLogin(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? ''
  const password = text.replace('/admin', '').trim()

  if (!password) {
    await ctx.reply('Usage: /admin <password>')
    return
  }

  if (password !== env.ADMIN_PASSWORD) {
    logger.warn({ chat_id: String(ctx.chat!.id), event: 'admin_login_failed' })
    await ctx.reply('❌ Wrong password.')
    return
  }

  ctx.session.isAdmin = true
  logger.info({ chat_id: String(ctx.chat!.id), event: 'admin_login_success' })

  const menu = new InlineKeyboard()
    .text('🔄 Sync Jobs', 'admin:sync').row()
    .text('📊 Stats', 'admin:stats').row()
    .text('🚪 Logout', 'admin:logout')

  await ctx.reply(
    '✅ *Admin mode activated*\n\nChoose an action:',
    { parse_mode: 'Markdown', reply_markup: menu }
  )
}

export async function handleAdminLogout(ctx: BotContext): Promise<void> {
  ctx.session.isAdmin = false
  await ctx.answerCallbackQuery()
  await ctx.reply('🚪 Logged out from admin mode.')
}

// ─── Sync Jobs (all sheets) ───────────────────────────────────────────────────

const SKIP_SHEETS = ['Sheet5', 'AI Interview Question']

export async function handleAdminSync(ctx: BotContext): Promise<void> {
  if (!ctx.session.isAdmin) return
  await ctx.answerCallbackQuery()
  await ctx.reply('🔄 Syncing knowledge base from ALL Google Sheets...')

  try {
    const { google } = await import('googleapis')
    const { MDocument } = await import('@mastra/rag')
    const { embed } = await import('ai')
    const { openai } = await import('@ai-sdk/openai')
    const { PgVector } = await import('@mastra/pg')
    const { INDEX_NAME, EMBEDDING_DIMENSION } = await import('../../mastra/rag/knowledge')

    const spreadsheetId = env.GOOGLE_JOBS_SPREADSHEET_ID
    if (!spreadsheetId) {
      await ctx.reply('❌ GOOGLE_JOBS_SPREADSHEET_ID not configured.')
      return
    }

    const JOB_LIST_SHEET = env.GOOGLE_JOBS_SHEET_NAME ?? 'List Job'
    const key = parseGoogleKey()
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const sheets = google.sheets({ version: 'v4', auth })

    // List all sheets, skip irrelevant ones
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' })
    const sheetNames = (spreadsheet.data.sheets ?? [])
      .map((s) => s.properties?.title ?? '')
      .filter((name) => name && !SKIP_SHEETS.includes(name))

    await ctx.reply(`📋 Found ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}`)

    const pgVector = new PgVector({ id: 'sync-vector', connectionString: env.DATABASE_URL })
    const indexes = await pgVector.listIndexes()
    if (!indexes.includes(INDEX_NAME)) {
      await pgVector.createIndex({ indexName: INDEX_NAME, dimension: EMBEDDING_DIMENSION, metric: 'cosine' })
    }

    const embeddingModel = openai.embedding('text-embedding-3-small')
    let totalDocs = 0
    let totalSheets = 0

    for (const sheetName of sheetNames) {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A:Z` })
      const rows = (res.data.values ?? []) as string[][]
      if (rows.length < 2) continue

      // Build documents — List Job uses column positions, other sheets use header names
      type Doc = { id_key: string; text: string; metadata: Record<string, string> }
      const docs: Doc[] = []

      if (sheetName === JOB_LIST_SHEET) {
        for (const r of rows.slice(1).filter((r) => r[0]?.trim())) {
          const judul = r[0]?.trim() ?? ''
          const lokasi = r[1]?.trim() ?? ''
          const sim = r[5]?.trim() || '-'
          const simText = sim !== '-' ? ` SIM ${sim}.` : ''
          docs.push({
            id_key: `${judul}::${lokasi}`,
            text: [
              `Posisi: ${judul}`,
              `Lokasi: ${lokasi}`,
              `Perusahaan/Client: ${r[3]?.trim() ?? ''}`,
              `Role: ${r[7]?.trim() ?? ''}`,
              `Deskripsi: ${r[2]?.trim() ?? ''}`,
              `Persyaratan: Usia ${r[4]?.trim() ?? ''} tahun. Pendidikan ${r[6]?.trim() ?? ''}.${simText}`,
              `Gaji: ${r[8]?.trim() ?? ''}`,
              `Benefit: ${r[9]?.trim() ?? ''}`,
              `Post Test: ${r[10]?.trim() || 'Tidak ada'}`,
              `Recruiter: ${r[11]?.trim() ?? ''} (${r[12]?.trim() ?? ''})`,
            ].join('\n'),
            metadata: {
              sheet_name: sheetName, judul_job: judul, lokasi,
              client: r[3]?.trim() ?? '', role: r[7]?.trim() ?? '',
              recruiter_name: r[11]?.trim() ?? '', recruitment_number: r[12]?.trim() ?? '',
            },
          })
        }
      } else {
        const headers = (rows[0] ?? []).map((h) => h?.trim() ?? '')
        rows.slice(1).forEach((r, i) => {
          if (!r.some((c) => c?.trim())) return
          const pairs = headers.map((h, idx) => ({ h, v: r[idx]?.trim() ?? '' })).filter(({ h, v }) => h && v)
          const metadata: Record<string, string> = { sheet_name: sheetName }
          pairs.forEach(({ h, v }) => { metadata[h.toLowerCase().replace(/\s+/g, '_')] = v })
          docs.push({
            id_key: `${sheetName}::${r[0]?.trim() ?? i}::${i}`,
            text: [`Sheet: ${sheetName}`, ...pairs.map(({ h, v }) => `${h}: ${v}`)].join('\n'),
            metadata,
          })
        })
      }

      // Embed & upsert each document
      for (const doc of docs) {
        const mdoc = MDocument.fromText(doc.text, doc.metadata)
        await mdoc.chunkRecursive({ maxSize: 1000, overlap: 100 })
        const chunks = await mdoc.chunk()
        for (const chunk of chunks) {
          const { embedding } = await embed({ model: embeddingModel, value: chunk.text })
          await pgVector.upsert({
            indexName: INDEX_NAME,
            vectors: [embedding],
            metadata: [{ ...chunk.metadata, text: chunk.text }],
            deleteFilter: { sheet_name: { $eq: sheetName }, id_key: { $eq: doc.id_key } },
          })
        }
      }

      totalDocs += docs.length
      totalSheets++
      await ctx.reply(`✅ '${sheetName}' — ${docs.length} doc(s) indexed`)
    }

    logger.info({ event: 'admin_sync_all_done', sheets: totalSheets, docs: totalDocs })
    await ctx.reply(
      `🎉 *Sync complete!*\n📋 ${totalSheets} sheet(s)\n📄 ${totalDocs} document(s) indexed into RAG`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error({ event: 'admin_sync_error', err })
    await ctx.reply(`❌ Sync failed: ${err}`)
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function handleAdminStats(ctx: BotContext): Promise<void> {
  if (!ctx.session.isAdmin) return
  await ctx.answerCallbackQuery()

  try {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: env.DATABASE_URL })

    const sessions = await pool.query('SELECT count(*) FROM bot_sessions')
    const bookings = await pool.query('SELECT count(*) FROM interview_bookings')
    const totalSessions = sessions.rows[0]?.count ?? 0
    const totalBookings = bookings.rows[0]?.count ?? 0

    await pool.end()

    const stats = [
      '📊 *Bot Statistics*',
      '',
      `👤 Total sessions: ${totalSessions}`,
      `📅 Interview bookings: ${totalBookings}`,
      `🕐 Uptime: ${formatUptime(process.uptime())}`,
      `💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    ].join('\n')

    await ctx.reply(stats, { parse_mode: 'Markdown' })
  } catch (err) {
    await ctx.reply(`❌ Error: ${err}`)
  }
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ─── Admin menu (re-show) ────────────────────────────────────────────────────

export async function handleAdminMenu(ctx: BotContext): Promise<void> {
  if (!ctx.session.isAdmin) {
    await ctx.reply('⚠️ Not in admin mode. Use /admin <password>')
    return
  }

  const menu = new InlineKeyboard()
    .text('🔄 Sync Jobs', 'admin:sync').row()
    .text('📊 Stats', 'admin:stats').row()
    .text('🚪 Logout', 'admin:logout')

  await ctx.reply('*Admin Menu*', { parse_mode: 'Markdown', reply_markup: menu })
}
