/**
 * Web FSM — mirrors the Telegram bot FSM but returns data instead of calling ctx.reply().
 * Uses the same shared tools (recruiter agent, data-needs, scoring, sheets).
 *
 * Transport layer (HTTP) is handled in web-chat.ts.
 * Business logic (state machine) lives here.
 */
import { mastra } from '../mastra/index'
import { loadDataNeeds } from '../mastra/tools/data-needs'
import { lookupJobRequirements, lookupFullJobDetail } from '../mastra/tools/job-lookup'
import { scoreCandidate } from '../mastra/tools/scoring-tool'
import { writeToSheets } from '../mastra/tools/sheets-tool'
import { downloadAndSaveFile } from '../mastra/tools/files-tool'
import { uploadToDrive } from '../mastra/tools/drive-upload'
import { trackUsage } from '../mastra/tools/usage-tracker'
import { env } from '../config/env'
import { logger } from '../logger'
import type { WebSession, WebJobListing } from './session'
import type { WebApiResponse, WebQuestion } from './types'

// ─── Job card parser (mirrors ask.ts) ────────────────────────────────────────

function parseJobsFromReply(reply: string): WebJobListing[] {
  const jobs: WebJobListing[] = []
  const cardRegex = /([1-9]️⃣|[1-9]\.)\s*<b>([^<]+)<\/b>\s*[—–-]\s*([^\n]+)([\s\S]*?)(?=[1-9]️⃣|[1-9]\.|$)/g
  let match: RegExpExecArray | null
  while ((match = cardRegex.exec(reply)) !== null) {
    const title = match[2]!.trim()
    const location = match[3]!.trim()
    const body = match[4] ?? ''
    const company = /🏢\s*(.+)/.exec(body)?.[1]?.trim()
    const requirements = /📋\s*(.+)/.exec(body)?.[1]?.trim()
    const salary = /💰\s*(.+)/.exec(body)?.[1]?.trim()
    jobs.push({ title, location, company, requirements, salary })
  }
  return jobs
}

// ─── Apply intent detection ───────────────────────────────────────────────────

function parseApplyByNumber(text: string): number | null {
  const m = /^(?:daftar|lamar|apply)\s+(\d+)\b/i.exec(text.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return n > 0 && n <= 20 ? n : null
}

function isApplyIntent(text: string): boolean {
  return /^(?:daftar|lamar|apply|mendaftar|melamar|ya|iya|oke|ok|mau|lanjut|setuju)\s*$/i.test(text.trim())
}

function parseSelectNumber(text: string): number | null {
  const m = /^(\d+)$/.exec(text.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return n > 0 && n <= 20 ? n : null
}

// ─── Question builder ─────────────────────────────────────────────────────────

async function getCurrentQuestion(session: WebSession): Promise<{
  question: WebQuestion
  questionIndex: number
  totalQuestions: number
} | null> {
  const questions = await loadDataNeeds()
  const q = questions[session.currentQuestionIndex]
  if (!q) return null
  return {
    question: {
      questionNumber: q.questionNumber,
      text: q.question,
      type: q.type,
      choices: q.choices.length ? q.choices : undefined,
      rules: q.rules || undefined,
      uploadCount: q.uploadCount,
    },
    questionIndex: session.currentQuestionIndex,
    totalQuestions: questions.length,
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

async function runWebScoring(session: WebSession): Promise<WebApiResponse> {
  const questions = await loadDataNeeds()

  // Extract candidate name from answers
  const nameQ = questions.find((q) => q.question.toLowerCase().includes('nama'))
  const candidateName = nameQ ? (session.answers[nameQ.questionNumber] ?? '') : ''

  const ageQ = questions.find((q) => q.question.toLowerCase().includes('umur') || q.question.toLowerCase().includes('usia') || q.question.toLowerCase().includes('lahir'))
  const ageStr = ageQ ? (session.answers[ageQ.questionNumber] ?? '') : ''
  const candidateAge = parseInt(ageStr, 10) || 0

  const eduQ = questions.find((q) => q.question.toLowerCase().includes('pendidikan'))
  const candidateEducation = eduQ ? (session.answers[eduQ.questionNumber] ?? '') : ''

  const simQ = questions.find((q) => q.question.toLowerCase().includes('sim'))
  const candidateSim = simQ ? (session.answers[simQ.questionNumber] ?? '') : ''

  // Save partial data to Sheets before scoring
  const sheetRow: Record<string, string> = {
    chat_id: session.sessionId,
    applied_job: session.appliedJob ?? '',
    status: 'partial',
  }
  for (const [qNum, ans] of Object.entries(session.answers)) {
    sheetRow[qNum] = ans
  }
  writeToSheets(sheetRow).catch((err) => logger.error({ event: 'web_sheets_error', err }))

  // Look up job requirements from pgvector
  const jobReqs = await lookupJobRequirements(session.appliedJob ?? '')

  const scoring = scoreCandidate({
    candidateAge,
    candidateEducation,
    jobAgeRange: jobReqs.jobAgeRange,
    jobEducationMin: jobReqs.jobEducationMin,
    candidateSimType: candidateSim || '',
    jobSimRequired: jobReqs.jobSimRequired || '',
  })

  const { score } = scoring

  // Save score to Sheets for recruiter — candidate always proceeds regardless of result
  writeToSheets(
    { chat_id: session.sessionId, score: String(score), status: 'qualified' },
    { interviewScore: String(score) },
  ).catch((err) => logger.error({ event: 'web_scoring_sheets_error', err }))

  // Build AI interview URL
  const interviewParams = new URLSearchParams({
    chat_id: session.sessionId,
    job: session.appliedJob ?? '',
    name: candidateName,
    lang: 'id',
  })
  const interviewUrl = env.PUBLIC_URL
    ? `${env.PUBLIC_URL}/interview?${interviewParams}`
    : `/interview?${interviewParams}`

  session.state = 'pass'
  return {
    state: 'pass',
    messages: [
      `🎉 <b>Data Anda telah berhasil kami terima!</b>`,
      `Langkah selanjutnya adalah sesi <b>AI Interview</b> singkat (5–10 menit).\n\n⚠️ <b>Perhatian sebelum memulai:</b>\n• Cari tempat yang <b>tenang dan minim kebisingan</b>\n• Pastikan koneksi internet stabil\n• Gunakan headset/earphone jika ada\n\nKlik tombol di bawah untuk memulai. 👇`,
    ],
    passed: true,
    interviewUrl,
  }
}

// ─── Main FSM handler ─────────────────────────────────────────────────────────

export async function handleWebMessage(
  session: WebSession,
  message: string,
): Promise<WebApiResponse> {

  // ── SCORING state: previous scoring attempt threw — retry on next message ──
  if (session.state === 'scoring') {
    try {
      return await runWebScoring(session)
    } catch (err) {
      logger.error({ event: 'web_scoring_retry_error', sessionId: session.sessionId, err })
      session.state = 'candidate_asking'
      return {
        state: 'candidate_asking',
        messages: ['⚠️ Maaf, terjadi kesalahan pada penilaian. Silakan ketik pesan untuk memulai kembali.'],
      }
    }
  }

  // ── FILE_UPLOAD state: user sent text instead of file ──────────────────────
  if (session.state === 'file_upload') {
    const qInfo = await getCurrentQuestion(session)
    return {
      state: 'file_upload',
      messages: ['Silakan kirim file (gambar atau PDF, maks 20MB).'],
      ...qInfo ?? {},
      uploadPage: session.currentUploadPage,
    }
  }

  // ── DATA_COLLECTION state ─────────────────────────────────────────────────
  if (session.state === 'data_collection') {
    const questions = await loadDataNeeds()
    const q = questions[session.currentQuestionIndex]

    if (!q) {
      // No more questions — run scoring
      session.state = 'scoring'
      const result = await runWebScoring(session)
      return result
    }

    if (q.type === 'Upload Docs') {
      session.state = 'file_upload'
      const qInfo = await getCurrentQuestion(session)
      return {
        state: 'file_upload',
        messages: [`📎 Silakan unggah: <b>${q.question}</b>`],
        ...qInfo ?? {},
        uploadPage: session.currentUploadPage,
        uploadCount: q.uploadCount,
      }
    }

    // Validate and save the answer
    const { validateAnswer } = await import('../mastra/tools/data-needs')
    const validation = validateAnswer(q, message)
    if (!validation.valid) {
      const qInfo = await getCurrentQuestion(session)
      return {
        state: 'data_collection',
        messages: [`⚠️ ${validation.error}`],
        ...qInfo ?? {},
      }
    }

    session.answers[q.questionNumber] = validation.parsed ?? message.trim()

    // Save partial to Sheets
    writeToSheets({
      chat_id: session.sessionId,
      [q.questionNumber]: session.answers[q.questionNumber]!,
      status: 'partial',
    }).catch(() => {})

    // Advance to next question
    session.currentQuestionIndex++
    const nextQ = questions[session.currentQuestionIndex]

    if (!nextQ) {
      session.state = 'scoring'
      return runWebScoring(session)
    }

    session.state = nextQ.type === 'Upload Docs' ? 'file_upload' : 'data_collection'

    const nextQInfo = await getCurrentQuestion(session)
    return {
      state: session.state,
      messages: session.state === 'file_upload'
        ? [`📎 Silakan unggah: <b>${nextQ.question}</b>`]
        : [],
      ...nextQInfo ?? {},
      uploadPage: session.currentUploadPage,
      uploadCount: nextQ.uploadCount,
    }
  }

  // ── CONSENT state: waiting for agree/decline action ───────────────────────
  if (session.state === 'consent') {
    return {
      state: 'consent',
      messages: [],
      appliedJob: session.appliedJob ?? '',
      appliedJobLocation: session.appliedJobLocation ?? '',
    }
  }

  // ── CANDIDATE_ASKING state ────────────────────────────────────────────────

  // Check for apply intent
  const applyNum = parseApplyByNumber(message)
  if (applyNum !== null) {
    if (session.lastShownJobs.length === 0) {
      return { state: 'candidate_asking', messages: ['Belum ada daftar lowongan yang ditampilkan. Ketik <b>ada lowongan</b> untuk melihat posisi tersedia. 😊'] }
    }
    const idx = applyNum - 1
    if (idx >= session.lastShownJobs.length) {
      return { state: 'candidate_asking', messages: [`Nomor ${applyNum} tidak ada di daftar. Hanya ada ${session.lastShownJobs.length} lowongan.`] }
    }
    const job = session.lastShownJobs[idx]!
    session.appliedJob = job.title
    session.appliedJobLocation = job.location
    session.state = 'consent'
    return {
      state: 'consent',
      messages: [`Baik! Saya akan membantu Anda mendaftar untuk posisi <b>${job.title}</b> di ${job.location}. Harap baca dan setujui persyaratan berikut.`],
      appliedJob: job.title,
      appliedJobLocation: job.location,
    }
  }

  if (isApplyIntent(message)) {
    if (session.pendingApplyJob) {
      const job = session.pendingApplyJob
      session.appliedJob = job.title
      session.appliedJobLocation = job.location
      session.state = 'consent'
      return {
        state: 'consent',
        messages: [`Baik! Saya akan membantu Anda mendaftar untuk posisi <b>${job.title}</b>. Harap baca persyaratan berikut.`],
        appliedJob: job.title,
        appliedJobLocation: job.location,
      }
    }
    if (session.lastShownJobs.length === 1) {
      const job = session.lastShownJobs[0]!
      session.appliedJob = job.title
      session.appliedJobLocation = job.location
      session.state = 'consent'
      return {
        state: 'consent',
        messages: [`Baik! Saya akan membantu Anda mendaftar untuk posisi <b>${job.title}</b>. Harap baca persyaratan berikut.`],
        appliedJob: job.title,
        appliedJobLocation: job.location,
      }
    }
    if (session.lastShownJobs.length > 1) {
      const list = session.lastShownJobs.map((j, i) => `  ${i + 1}. <b>${j.title}</b> — ${j.location}`).join('\n')
      return { state: 'candidate_asking', messages: [`Posisi mana yang ingin Anda lamar?\n\n${list}\n\nBalas dengan <b>nomor</b> atau ketik <b>daftar [nomor]</b>. 😊`] }
    }
    return { state: 'candidate_asking', messages: ['Anda ingin melamar posisi apa? Ketik <b>ada lowongan</b> untuk melihat daftar posisi tersedia.'] }
  }

  const selectNum = parseSelectNumber(message)
  if (selectNum !== null && session.lastShownJobs.length > 0) {
    const idx = selectNum - 1
    if (idx < session.lastShownJobs.length) {
      if (session.pendingApplyJob) {
        const job = session.pendingApplyJob
        session.appliedJob = job.title
        session.appliedJobLocation = job.location
        session.state = 'consent'
        return {
          state: 'consent',
          messages: [`Baik, lanjut pendaftaran untuk <b>${job.title}</b>. Harap baca persyaratan berikut.`],
          appliedJob: job.title,
          appliedJobLocation: job.location,
        }
      }
      // Show job detail for the selected number
      const selected = session.lastShownJobs[idx]!
      session.pendingApplyJob = selected

      const detail = await lookupFullJobDetail(selected.title)
      const lines: string[] = [`<b>${selected.title}</b> — ${selected.location}`]
      if (detail?.company || selected.company) lines.push(`🏢 ${detail?.company ?? selected.company}`)
      if (detail?.description) lines.push(`📄 <i>${detail.description}</i>`)
      if (detail?.requirements || selected.requirements) lines.push(`📋 ${detail?.requirements ?? selected.requirements}`)
      if (detail?.salary || selected.salary) lines.push(`💰 ${detail?.salary ?? selected.salary}`)
      if (detail?.benefit) lines.push(`🎁 ${detail.benefit}`)
      lines.push('')
      lines.push('Tertarik? Ketik <b>daftar</b> atau <b>ya</b> untuk melamar posisi ini. 😊')

      return { state: 'candidate_asking', messages: [lines.join('\n')] }
    }
  }

  // Forward to recruiter agent
  const messageWithContext = `[CHAT_ID:${session.sessionId}]\n${
    session.lastShownJobs.length
      ? `[LAST SHOWN JOBS:\n${session.lastShownJobs.map((j, i) => `  ${i + 1}. ${j.title} — ${j.location}`).join('\n')}\n]\n`
      : ''
  }${message}`

  try {
    const agent = mastra.getAgent('recruiterAgent')
    const result = await agent.generate(messageWithContext, {
      memory: { thread: `web-${session.sessionId}`, resource: `web-${session.sessionId}` },
    })
    const reply = result.text ?? ''

    if (result.totalUsage) {
      trackUsage(session.sessionId, 'gpt-4o', result.totalUsage.inputTokens ?? 0, result.totalUsage.outputTokens ?? 0)
    }

    // Parse jobs from reply and store in session
    const parsedJobs = parseJobsFromReply(reply)
    if (parsedJobs.length > 0) {
      session.lastShownJobs = parsedJobs
      session.pendingApplyJob = null
    }

    return { state: 'candidate_asking', messages: [reply] }
  } catch (err) {
    logger.error({ event: 'web_agent_error', sessionId: session.sessionId, err })
    return {
      state: 'candidate_asking',
      messages: ['⚠️ Maaf, saya sedang mengalami gangguan teknis. Silakan coba lagi.'],
    }
  }
}

// ─── Consent handlers ─────────────────────────────────────────────────────────

export async function handleWebConsentAgree(session: WebSession): Promise<WebApiResponse> {
  session.consentRecordedAt = new Date().toISOString()

  // Create initial Sheets row
  writeToSheets({
    chat_id: session.sessionId,
    applied_job: session.appliedJob ?? '',
    status: 'partial',
  }).catch(() => {})

  const questions = await loadDataNeeds()
  if (questions.length === 0) {
    session.state = 'scoring'
    return runWebScoring(session)
  }

  session.state = questions[0]!.type === 'Upload Docs' ? 'file_upload' : 'data_collection'
  session.currentQuestionIndex = 0

  const qInfo = await getCurrentQuestion(session)
  return {
    state: session.state,
    messages: ['✅ Terima kasih telah menyetujui. Mari kita mulai pengumpulan data.'],
    ...qInfo ?? {},
    uploadPage: 1,
    uploadCount: questions[0]?.uploadCount,
  }
}

export function handleWebConsentDecline(session: WebSession): WebApiResponse {
  session.state = 'candidate_asking'
  session.appliedJob = null
  session.appliedJobLocation = null
  return {
    state: 'candidate_asking',
    messages: ['Tidak masalah! Jika ada pertanyaan lain atau ingin melihat lowongan lain, saya siap membantu. 😊'],
  }
}

// ─── File upload handler ──────────────────────────────────────────────────────

export async function handleWebFileUpload(
  session: WebSession,
  fileId: string,
  fileName: string,
  fileSize: number,
  mimeType: string,
  fileBuffer: ArrayBuffer,
): Promise<WebApiResponse> {
  const questions = await loadDataNeeds()
  const q = questions[session.currentQuestionIndex]

  if (!q || q.type !== 'Upload Docs') {
    // Session already advanced past upload questions but scoring threw on the previous attempt —
    // re-run scoring so the user doesn't get stuck.
    if (session.state === 'scoring') {
      try {
        return await runWebScoring(session)
      } catch (err) {
        logger.error({ event: 'web_scoring_retry_error', sessionId: session.sessionId, err })
        session.state = 'candidate_asking'
        return {
          state: 'candidate_asking',
          messages: ['⚠️ Maaf, terjadi kesalahan pada penilaian. Silakan ketik pesan untuk memulai kembali.'],
        }
      }
    }
    return { state: 'candidate_asking', messages: ['❌ Saat ini tidak perlu upload file. Silakan ikuti instruksi di atas.'] }
  }

  const uploadCount = q.uploadCount ?? 1
  const page = session.currentUploadPage

  // Build filename with page suffix if multi-page
  const slug = q.question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !new Set(['upload', 'kirimkan', 'silakan', 'foto', 'file', 'dokumen', 'anda', 'dari', 'yang']).has(w))
    .join('_')
    .slice(0, 40) || 'file'

  const ext = fileName.split('.').pop() ?? (mimeType.includes('pdf') ? 'pdf' : 'jpg')
  const finalName = uploadCount > 1 ? `${slug}_halaman_${page}.${ext}` : `${slug}.${ext}`

  // Save file locally then upload to Drive
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = join('uploads', session.sessionId)
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, finalName)
  writeFileSync(localPath, Buffer.from(fileBuffer))

  let filePath = localPath
  try {
    const driveResult = await uploadToDrive(session.sessionId, localPath, 'cv')
    if (driveResult.success && driveResult.driveUrl) filePath = driveResult.driveUrl
  } catch {
    // Drive upload failed - keep local path
  }

  // Accumulate multi-page answers
  const existing = session.answers[q.questionNumber]
  session.answers[q.questionNumber] = existing ? `${existing}, ${filePath}` : filePath

  if (uploadCount > 1 && page < uploadCount) {
    session.currentUploadPage = page + 1
    const qInfo = await getCurrentQuestion(session)
    return {
      state: 'file_upload',
      messages: [`✅ Halaman ${page} diterima. Sekarang kirim halaman ${page + 1} dari ${uploadCount}.`],
      ...qInfo ?? {},
      uploadPage: page + 1,
      uploadCount,
    }
  }

  // All pages received — save to Sheets and advance
  session.currentUploadPage = 1
  writeToSheets({
    chat_id: session.sessionId,
    [q.questionNumber]: session.answers[q.questionNumber]!,
    status: 'partial',
  }).catch(() => {})

  session.currentQuestionIndex++
  const nextQ = questions[session.currentQuestionIndex]

  if (!nextQ) {
    session.state = 'scoring'
    // If scoring throws, the session stays in 'scoring' state so the next upload
    // retry (above) will re-run it rather than returning a confusing "not expected" error.
    return runWebScoring(session)
  }

  session.state = nextQ.type === 'Upload Docs' ? 'file_upload' : 'data_collection'
  const nextQInfo = await getCurrentQuestion(session)

  return {
    state: session.state,
    messages: ['✅ File diterima.'],
    ...nextQInfo ?? {},
    uploadPage: 1,
    uploadCount: nextQ.uploadCount,
  }
}

// ─── Session restore ──────────────────────────────────────────────────────────

/**
 * Returns a WebApiResponse that restores the UI to the current session state.
 * Returns null when the session is at the start (no restoration needed).
 */
export async function resumeWebSession(session: WebSession): Promise<WebApiResponse | null> {
  switch (session.state) {
    case 'candidate_asking':
    case 'escalated':
      return null

    case 'consent':
      return {
        state: 'consent',
        messages: [],
        appliedJob: session.appliedJob ?? '',
        appliedJobLocation: session.appliedJobLocation ?? '',
      }

    case 'data_collection':
    case 'file_upload': {
      const qInfo = await getCurrentQuestion(session)
      return {
        state: session.state,
        messages: [],
        ...qInfo ?? {},
        uploadPage: session.currentUploadPage,
      }
    }

    case 'scoring':
      return runWebScoring(session)

    case 'pass': {
      const questions = await loadDataNeeds()
      const nameQ = questions.find((q) => q.question.toLowerCase().includes('nama'))
      const candidateName = nameQ ? (session.answers[nameQ.questionNumber] ?? '') : ''
      const interviewParams = new URLSearchParams({
        chat_id: session.sessionId,
        job: session.appliedJob ?? '',
        name: candidateName,
        lang: 'id',
      })
      const interviewUrl = env.PUBLIC_URL
        ? `${env.PUBLIC_URL}/interview?${interviewParams}`
        : `/interview?${interviewParams}`
      return { state: 'pass', messages: [], passed: true, interviewUrl }
    }

    case 'fail':
      // Web flow no longer produces fail — reset to start
      session.state = 'candidate_asking'
      return null

    case 'interview_completed':
      return { state: 'interview_completed', messages: [] }

    default:
      return null
  }
}
