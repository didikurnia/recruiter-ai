import { Bot, webhookCallback } from 'grammy'
import { env } from '../config/env'
import { logger } from '../logger'
import { createSessionMiddleware, type BotContext } from './middleware/session'
import { requireSession } from './middleware/guard'
import { startCommand } from './commands/start'
// Language selection removed — Indonesian only
import { handleCandidateMessage } from './handlers/ask'
import { handleAdminUpload } from './handlers/admin-upload'
import {
  handleConsentAgree, handleConsentDecline,
  handleDataCollection,
  handleFileUpload,
  handleRejectionBrowse, handleRejectionExit,
} from './handlers/fsm'
import { handleInterviewBooking } from './handlers/interview'
import { startIdleWatcher, handleIdleContinue, handleIdleRestart } from './idle-watcher'
import {
  handleAdminLogin, handleAdminLogout, handleAdminSync,
  handleAdminStats, handleAdminMenu,
} from './handlers/admin'
import { PostgresSessionStorage } from '../db/session-storage'
import { FsmState } from '../types/candidate'

export const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN)

bot.use(createSessionMiddleware(new PostgresSessionStorage()))
bot.use(requireSession)

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.command('start', startCommand)
bot.command('admin', handleAdminLogin)
bot.command('menu', handleAdminMenu)

// ─── Consent callbacks ────────────────────────────────────────────────────────
bot.callbackQuery('consent:agree', handleConsentAgree)
bot.callbackQuery('consent:decline', handleConsentDecline)

// ─── Rejection callbacks ──────────────────────────────────────────────────────
bot.callbackQuery('rejection:browse', handleRejectionBrowse)
bot.callbackQuery('rejection:exit', handleRejectionExit)

// ─── Interview scheduling ────────────────────────────────────────────────────
bot.callbackQuery(/^interview:/, handleInterviewBooking)

// ─── Idle callbacks ──────────────────────────────────────────────────────────
bot.callbackQuery('idle:continue', handleIdleContinue)
bot.callbackQuery('idle:restart', handleIdleRestart)

// ─── Admin callbacks ─────────────────────────────────────────────────────────
bot.callbackQuery('admin:sync', handleAdminSync)
bot.callbackQuery('admin:stats', handleAdminStats)
bot.callbackQuery('admin:logout', handleAdminLogout)

// ─── Admin: document upload ───────────────────────────────────────────────────
bot.on('message:document', async (ctx) => {
  logger.info({ chat_id: String(ctx.chat.id), event: 'document_received', fsmState: ctx.session.fsmState })
  // Admin upload takes priority over file-upload FSM step
  const adminIds = env.ADMIN_TELEGRAM_CHAT_IDS.split(',').map((id) => id.trim())
  if (adminIds.includes(String(ctx.chat.id))) {
    return handleAdminUpload(ctx)
  }
  // Candidate file upload during FILE_UPLOAD state
  if (ctx.session.fsmState === FsmState.FILE_UPLOAD) {
    return handleFileUpload(ctx)
  }
})

// ─── Candidate: photo upload ──────────────────────────────────────────────────
bot.on('message:photo', async (ctx) => {
  logger.info({ chat_id: String(ctx.chat.id), event: 'photo_received', fsmState: ctx.session.fsmState })
  if (ctx.session.fsmState === FsmState.FILE_UPLOAD) {
    return handleFileUpload(ctx)
  }
  // If not in FILE_UPLOAD state, tell user what to do
  const l = ctx.session.language ?? 'id'
  await ctx.reply(
    l === 'id'
      ? '⚠️ Saat ini saya tidak memerlukan foto. Silakan ikuti instruksi di atas.'
      : '⚠️ I don\'t need a photo right now. Please follow the instructions above.'
  )
})

// ─── Text messages: FSM-routed ────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const state = ctx.session.fsmState

  if (state === FsmState.DATA_COLLECTION) {
    return handleDataCollection(ctx)
  }

  // All other states → recruiter agent (RAG Q&A)
  return handleCandidateMessage(ctx)
})

export async function startBot(): Promise<void> {
  const { handleCalendlyWebhook } = await import('./handlers/calendly-webhook')
  const { handleRealtimeSession, handleRealtimeComplete, serveInterviewPage } = await import('./handlers/realtime-api')
  const { handleWebChat, handleWebConsent, handleWebUpload, handleWebState } = await import('./handlers/web-chat')

  // Shared HTTP request router
  function routeRequest(req: Request, fallback?: (req: Request) => Response | Promise<Response>): Response | Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/webhooks/calendly' && req.method === 'POST') return handleCalendlyWebhook(req)
    if (url.pathname === '/api/realtime/session' && req.method === 'POST') return handleRealtimeSession(req)
    if (url.pathname === '/api/realtime/complete' && req.method === 'POST') return handleRealtimeComplete(req)
    if (url.pathname === '/interview') return serveInterviewPage()
    if (url.pathname === '/api/web/chat') return handleWebChat(req)
    if (url.pathname === '/api/web/consent') return handleWebConsent(req)
    if (url.pathname === '/api/web/upload') return handleWebUpload(req)
    if (url.pathname.startsWith('/api/web/state/')) return handleWebState(req)
    return fallback ? fallback(req) : new Response('OK', { status: 200 })
  }

  if (env.TELEGRAM_WEBHOOK_URL) {
    const secret = env.TELEGRAM_WEBHOOK_SECRET ?? ''
    const tgHandler = webhookCallback(bot, 'bun', { secretToken: secret || undefined })
    Bun.serve({ port: 3000, reusePort: true, fetch: (req: Request) => routeRequest(req, tgHandler) })
    await bot.api.setWebhook(env.TELEGRAM_WEBHOOK_URL, {
      secret_token: secret || undefined,
    })
    logger.info({ msg: 'bot started', mode: 'webhook', url: env.TELEGRAM_WEBHOOK_URL })
  } else {
    Bun.serve({ port: 3000, reusePort: true, fetch: (req: Request) => routeRequest(req) })
    bot.start()
    logger.info({ msg: 'bot started', mode: 'polling', webhookServer: 'http://localhost:3000' })
  }

  // Start idle watcher (background task)
  startIdleWatcher(bot)
}
