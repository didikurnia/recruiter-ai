/**
 * HTTP transport layer for the web FSM.
 * Business logic lives in src/web/fsm.ts.
 */
import { getOrCreateSession, saveSession } from '../../web/session'
import {
  handleWebMessage,
  handleWebConsentAgree,
  handleWebConsentDecline,
  handleWebFileUpload,
} from '../../web/fsm'
import { logger } from '../../logger'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

// POST /api/web/chat
export async function handleWebChat(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  try {
    const body = await req.json()
    const { message, sessionId } = body
    if (!message?.trim()) {
      return json({ state: 'candidate_asking', messages: ['Pesan tidak boleh kosong.'] }, 400)
    }
    const session = getOrCreateSession(sessionId ?? 'anon')
    const result = await handleWebMessage(session, message)
    saveSession(session)
    logger.info({ event: 'web_chat', sessionId, state: result.state })
    return json(result)
  } catch (err: any) {
    logger.error({ event: 'web_chat_error', err: err.message })
    return json({ state: 'candidate_asking', messages: ['⚠️ Terjadi kesalahan. Silakan coba lagi.'] }, 500)
  }
}

// POST /api/web/consent
export async function handleWebConsent(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  try {
    const body = await req.json()
    const { action, sessionId } = body
    const session = getOrCreateSession(sessionId ?? 'anon')
    const result = action === 'agree'
      ? await handleWebConsentAgree(session)
      : handleWebConsentDecline(session)
    saveSession(session)
    return json(result)
  } catch (err: any) {
    logger.error({ event: 'web_consent_error', err: err.message })
    return json({ state: 'candidate_asking', messages: ['⚠️ Terjadi kesalahan.'] }, 500)
  }
}

// POST /api/web/upload - multipart/form-data with fields: file, sessionId
export async function handleWebUpload(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  try {
    // req.formData() is the standard Web API method for multipart parsing in Bun
    const form = await (req as Request & { formData(): Promise<FormData> }).formData()
    const rawSid = form.get('sessionId')
    const sessionId = typeof rawSid === 'string' ? rawSid : 'anon'
    const file = form.get('file')

    if (!file || !(file instanceof File)) {
      return json({ state: 'file_upload', messages: ['❌ File tidak ditemukan.'] }, 400)
    }
    if (file.size > 20 * 1024 * 1024) {
      return json({ state: 'file_upload', messages: ['❌ Ukuran file maksimal 20MB.'] }, 400)
    }

    const session = getOrCreateSession(sessionId)
    const buffer = await file.arrayBuffer()
    const result = await handleWebFileUpload(session, file.name, file.name, file.size, file.type, buffer)
    saveSession(session)
    return json(result)
  } catch (err: any) {
    logger.error({ event: 'web_upload_error', err: err.message })
    return json({ state: 'file_upload', messages: ['⚠️ Upload gagal. Silakan coba lagi.'] }, 500)
  }
}

// GET /api/web/state/:sessionId
export async function handleWebState(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  try {
    const url = new URL(req.url)
    const sessionId = url.pathname.split('/').pop() ?? ''
    const session = getOrCreateSession(sessionId)

    const { resumeWebSession } = await import('../../web/fsm')
    const resumed = await resumeWebSession(session)
    if (resumed) {
      saveSession(session)
      return json(resumed)
    }
    return json({ state: 'candidate_asking', messages: [] })
  } catch (err: any) {
    logger.error({ event: 'web_state_error', err: err.message })
    return json({ state: 'candidate_asking', messages: [] }, 500)
  }
}
