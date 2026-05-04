import type { NextFunction } from 'grammy'
import type { BotContext } from './session'
import { logger } from '../../logger'

const WINDOW_MS = 5 * 60 * 1000    // 5-minute sliding window
const MAX_PER_WINDOW = 20           // messages per window before cooldown
const BURST_WINDOW_MS = 10_000      // 10-second burst window
const MAX_BURST = 5                 // messages per burst window
const COOLDOWN_MS = 2 * 60 * 1000  // 2-minute cooldown
const MAX_DUPLICATES = 3            // consecutive identical messages before drop

interface UserRecord {
  timestamps: number[]
  lastText: string | null
  duplicateCount: number
  cooldownUntil: number
  warnedThisCooldown: boolean
}

const store = new Map<number, UserRecord>()

// Prune stale entries every 15 minutes to avoid memory leak
setInterval(() => {
  const now = Date.now()
  for (const [id, rec] of store) {
    const hasRecentMsg = rec.timestamps.at(-1) !== undefined && now - rec.timestamps.at(-1)! < WINDOW_MS
    const onCooldown = now < rec.cooldownUntil
    if (!hasRecentMsg && !onCooldown) store.delete(id)
  }
}, 15 * 60 * 1000)

function getRecord(chatId: number): UserRecord {
  return store.get(chatId) ?? {
    timestamps: [],
    lastText: null,
    duplicateCount: 0,
    cooldownUntil: 0,
    warnedThisCooldown: false,
  }
}

export async function rateLimitMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  // Only rate-limit inbound text messages; commands and callbacks are always allowed
  if (!ctx.message?.text || ctx.message.text.startsWith('/') || ctx.callbackQuery) {
    return next()
  }

  const chatId = ctx.chat?.id
  if (!chatId) return next()

  // Admins bypass all limits
  if (ctx.session.isAdmin) return next()

  const now = Date.now()
  const rec = getRecord(chatId)

  // ── Cooldown check ─────────────────────────────────────────────────────────
  if (now < rec.cooldownUntil) {
    if (!rec.warnedThisCooldown) {
      rec.warnedThisCooldown = true
      store.set(chatId, rec)
      const remainingSec = Math.ceil((rec.cooldownUntil - now) / 1000)
      await ctx.reply(`⏳ Terlalu banyak pesan. Silakan tunggu ${remainingSec} detik sebelum melanjutkan.`)
    }
    logger.warn({ event: 'rate_limit_blocked', chatId, reason: 'cooldown' })
    return
  }

  // Reset cooldown state once it expires
  if (rec.cooldownUntil > 0 && now >= rec.cooldownUntil) {
    rec.cooldownUntil = 0
    rec.warnedThisCooldown = false
  }

  // ── Duplicate detection ────────────────────────────────────────────────────
  const text = ctx.message.text.trim()
  if (text === rec.lastText) {
    rec.duplicateCount++
  } else {
    rec.duplicateCount = 0
    rec.lastText = text
  }

  if (rec.duplicateCount >= MAX_DUPLICATES) {
    store.set(chatId, rec)
    logger.warn({ event: 'rate_limit_blocked', chatId, reason: 'duplicate', count: rec.duplicateCount })
    return // silently drop — no reply to avoid rewarding spam
  }

  // ── Sliding window (5-min) ─────────────────────────────────────────────────
  const windowStart = now - WINDOW_MS
  rec.timestamps = rec.timestamps.filter((t) => t > windowStart)
  rec.timestamps.push(now)

  if (rec.timestamps.length > MAX_PER_WINDOW) {
    rec.cooldownUntil = now + COOLDOWN_MS
    rec.warnedThisCooldown = false
    store.set(chatId, rec)
    await ctx.reply('⚠️ Anda mengirim terlalu banyak pesan. Harap tunggu 2 menit sebelum melanjutkan.')
    logger.warn({ event: 'rate_limit_triggered', chatId, reason: 'window', count: rec.timestamps.length })
    return
  }

  // ── Burst check (10-sec) ──────────────────────────────────────────────────
  const burstStart = now - BURST_WINDOW_MS
  const burstCount = rec.timestamps.filter((t) => t > burstStart).length

  if (burstCount > MAX_BURST) {
    rec.cooldownUntil = now + COOLDOWN_MS
    rec.warnedThisCooldown = false
    store.set(chatId, rec)
    await ctx.reply('⚠️ Anda mengirim terlalu cepat. Harap tunggu 2 menit sebelum melanjutkan.')
    logger.warn({ event: 'rate_limit_triggered', chatId, reason: 'burst', burstCount })
    return
  }

  store.set(chatId, rec)
  return next()
}
