/**
 * API endpoints for the AI voice interview Mini App.
 *
 * POST /api/realtime/session  — Create ephemeral OpenAI Realtime token
 * POST /api/realtime/complete — Save interview transcript + generate summary
 * GET  /interview              — Serve the Mini App HTML
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { google } from 'googleapis'
import { env, parseGoogleKey } from '../../config/env'
import { writeToSheets } from '../../mastra/tools/sheets-tool'
import { uploadToDrive } from '../../mastra/tools/drive-upload'
import { scoreInterviewTranscript, formatScoreDetail } from '../../mastra/tools/interview-scoring-tool'
import { loadDataNeeds } from '../../mastra/tools/data-needs'
import { trackUsage, getSessionSnapshot, getSessionSummary, clearSession } from '../../mastra/tools/usage-tracker'
import { writeUsageToSheet } from '../../mastra/tools/usage-sheet'
import { pool } from '../../db/client'
import { logger } from '../../logger'

/** Load collected Data_Needs answers from session storage, mapped by question text */
async function loadCollectedAnswers(chatId: string): Promise<Record<string, string>> {
  try {
    const res = await pool.query('SELECT data FROM bot_sessions WHERE key = $1', [chatId])
    const raw = res.rows[0]?.data as { answers?: Record<string, string> } | undefined
    const answers = raw?.answers ?? {}
    if (Object.keys(answers).length === 0) return {}

    // Map question_number → question text
    const questions = await loadDataNeeds()
    const result: Record<string, string> = {}
    for (const q of questions) {
      if (answers[q.questionNumber]) {
        result[q.question] = answers[q.questionNumber]!
      }
    }
    return result
  } catch (err) {
    logger.error({ event: 'load_collected_answers_error', chatId, err })
    return {}
  }
}
import { bot } from '../index'

const INTERVIEW_HTML = readFileSync(join(import.meta.dir, '..', '..', 'web', 'interview.html'), 'utf8')

// ─── Fetch interview questions from Google Sheets ────────────────────────────

interface InterviewQuestion {
  category: string
  question: string
  purpose: string
  expectedAnswer: string
  redFlag: string
  position: string // "Semua", "Rider", "Driver", "Rider/Driver", etc.
}

async function fetchInterviewQuestions(): Promise<InterviewQuestion[]> {
  const spreadsheetId = env.GOOGLE_JOBS_SPREADSHEET_ID
  if (!spreadsheetId) return []

  try {
    const key = parseGoogleKey()
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const sheets = google.sheets({ version: 'v4', auth })
    // SPX Question columns: Question_Number, Category, Question, Role, Jawaban yang Diharapkan, Persentage jawaban, ...
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'SPX Question!A2:G100',
    })

    return (res.data.values ?? [])
      .filter((r: string[]) => r[1]?.trim() === 'Interview' && r[2]?.trim())
      .map((r: string[]): InterviewQuestion => ({
        category: 'Interview',
        question: r[2]?.trim() ?? '',
        purpose: '',
        expectedAnswer: r[4]?.trim() ?? '',
        redFlag: '',
        position: r[3]?.trim() || 'Semua',
      }))
  } catch (err) {
    logger.error({ event: 'fetch_interview_questions_error', err })
    return []
  }
}

// ─── Fetch candidate FAQ answers from Google Sheets ──────────────────────────

interface CandidateFAQ {
  question: string
  answer: string
  notes: string
}

async function fetchCandidateFAQ(): Promise<CandidateFAQ[]> {
  const spreadsheetId = env.GOOGLE_JOBS_SPREADSHEET_ID
  if (!spreadsheetId) return []

  try {
    const key = parseGoogleKey()
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const sheets = google.sheets({ version: 'v4', auth })
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'AI Interview Candidate Answer!A2:D100',
    })

    return (res.data.values ?? [])
      .filter((r: string[]) => r[1]?.trim())
      .map((r: string[]): CandidateFAQ => ({
        question: r[1]?.trim() ?? '',
        answer: r[2]?.trim() ?? '',
        notes: r[3]?.trim() ?? '',
      }))
  } catch (err) {
    logger.error({ event: 'fetch_candidate_faq_error', err })
    return []
  }
}

/** Filter questions relevant to the job position */
function filterQuestionsForJob(questions: InterviewQuestion[], job: string): InterviewQuestion[] {
  const jobLower = job.toLowerCase()
  const isRider = jobLower.includes('kurir') || jobLower.includes('rider')
  const isDriver = jobLower.includes('driver')

  return questions.filter((q) => {
    const pos = q.position.toLowerCase()
    if (pos === 'semua') return true
    if (isRider && (pos.includes('rider') || pos === 'semua')) return true
    if (isDriver && (pos.includes('driver') || pos === 'semua')) return true
    if (!isRider && !isDriver && pos === 'semua') return true
    return false
  })
}

// ─── AI interviewer instructions ─────────────────────────────────────────────

function buildInstructions(name: string, job: string, lang: string, questions: InterviewQuestion[], faq: CandidateFAQ[], collectedData: Record<string, string> = {}): string {
  if (questions.length > 0) {
    // Group questions by category for structured flow
    const grouped = new Map<string, InterviewQuestion[]>()
    for (const q of questions) {
      const list = grouped.get(q.category) ?? []
      list.push(q)
      grouped.set(q.category, list)
    }

    let questionList = ''
    let num = 1
    for (const [category, qs] of grouped) {
      questionList += `\n  [${category}]\n`
      for (const q of qs) {
        questionList += `  ${num}. ${q.question.replace('{R.Nama}', name || 'kandidat')}\n`
        questionList += `     Tujuan: ${q.purpose}\n`
        questionList += `     Jawaban baik: ${q.expectedAnswer}\n`
        questionList += `     Red flag: ${q.redFlag}\n`
        num++
      }
    }

    // Build FAQ knowledge base for the "any questions?" phase
    let faqSection = ''
    if (faq.length > 0) {
      faqSection = '\n\nDATABASE JAWABAN UNTUK PERTANYAAN KANDIDAT:\n'
      faqSection += '(Gunakan informasi ini untuk menjawab jika kandidat bertanya)\n'
      for (const f of faq) {
        faqSection += `\nQ: ${f.question}\nA: ${f.answer}`
        if (f.notes) faqSection += `\n   Catatan: ${f.notes}`
        faqSection += '\n'
      }
    }

    // Build data validation section — what the candidate already answered during screening
    let dataSection = ''
    if (Object.keys(collectedData).length > 0) {
      dataSection = '\n\nDATA KANDIDAT DARI SCREENING DASAR (sudah diisi sebelum interview):\n'
      for (const [question, answer] of Object.entries(collectedData)) {
        dataSection += `  - ${question}: ${answer}\n`
      }
      dataSection += `
VALIDASI DATA — IMPORTANT:
- Saat menanyakan pertanyaan interview yang terkait data di atas (contoh: nama, KTP, alamat, SIM, motor), bandingkan jawaban kandidat dengan data yang sudah diisi
- Jika TIDAK COCOK atau ada perbedaan:
  * Jangan langsung menolak
  * Tanya ulang untuk klarifikasi: "Oh, tadi di form Anda isi X, tapi sekarang Anda bilang Y. Mana yang benar?"
  * Catat inkonsistensi untuk recruiter
- Jika COCOK: konfirmasi singkat dan lanjut ke pertanyaan berikutnya
`
    }

    return `Kamu adalah interviewer AI profesional untuk posisi ${job || 'umum'}.
Kandidat bernama ${name || 'kandidat'}.

ATURAN BAHASA — WAJIB:
- SELALU gunakan Bahasa Indonesia untuk SEMUA respons tanpa terkecuali
- JANGAN pernah beralih ke bahasa lain meskipun kandidat berbicara dalam bahasa Inggris, Mandarin, atau bahasa asing lainnya

VALIDASI JAWABAN — PENTING:
- Jika jawaban kandidat tidak jelas, tidak terdengar, atau tampak bukan Bahasa Indonesia (misalnya teks acak, kata-kata asing yang tidak relevan, atau kalimat yang tidak masuk akal), JANGAN lanjutkan ke pertanyaan berikutnya
- Minta kandidat mengulang dengan sopan, gunakan salah satu variasi ini:
  * "Maaf, jawaban Anda kurang terdengar jelas. Boleh diulang kembali?"
  * "Mohon maaf, saya kurang menangkap jawaban Anda. Bisa disampaikan sekali lagi?"
  * "Sepertinya ada gangguan audio. Bisa tolong diulang jawabannya?"
- Jika setelah 2 kali pengulangan masih tidak jelas, catat sebagai "jawaban tidak terdengar" dan lanjut ke pertanyaan berikutnya

ATURAN INTERVIEW:
- Ikuti daftar pertanyaan di bawah secara berurutan per kategori
- Gunakan "Tujuan" untuk memahami apa yang kamu cari dari jawaban kandidat
- Gunakan "Jawaban baik" sebagai benchmark — jika kandidat menjawab sesuai, beri respons positif singkat
- Perhatikan "Red flag" — jika kandidat menunjukkan tanda ini, catat secara mental tapi JANGAN menghakimi atau menolak langsung
- Dengarkan jawaban kandidat dengan baik, berikan respons singkat sebelum pertanyaan berikutnya
- Jaga nada profesional namun ramah — seperti recruiter yang berpengalaman
- Jangan terlalu panjang berbicara — ini interview, bukan kuliah
- Jika kandidat tidak paham pertanyaan, jelaskan ulang dengan bahasa yang lebih sederhana

ALUR INTERVIEW:
1. Tanyakan semua PERTANYAAN INTERVIEW di bawah secara berurutan
2. VALIDASI jawaban terhadap DATA KANDIDAT (jika tersedia) — minta klarifikasi kalau tidak cocok
3. Setelah SEMUA pertanyaan selesai, tanyakan: "Apakah ada yang ingin kamu tanyakan tentang posisi ini atau tentang perusahaan?"
4. Jika kandidat bertanya, jawab menggunakan DATABASE JAWABAN di bawah. Jika pertanyaannya tidak ada di database, jawab "Itu pertanyaan bagus, nanti recruiter kami akan menjelaskan lebih detail saat interview lanjutan."
5. Kandidat boleh bertanya beberapa kali. Setiap selesai menjawab, tanya lagi "Ada pertanyaan lain?"
6. Jika kandidat bilang tidak ada pertanyaan lagi, ucapkan terima kasih dan tutup interview
${dataSection}
PERTANYAAN INTERVIEW:
${questionList}${faqSection}`
  }

  // Fallback: generic questions when sheet is empty
  if (lang === 'id') {
    // Build FAQ for fallback too
    let fallbackFaq = ''
    if (faq.length > 0) {
      fallbackFaq = '\n\nDATABASE JAWABAN:\n'
      for (const f of faq) {
        fallbackFaq += `Q: ${f.question}\nA: ${f.answer}\n`
      }
    }

    return `Kamu adalah interviewer AI profesional untuk posisi ${job || 'umum'}.
Kandidat bernama ${name || 'kandidat'}.

ATURAN BAHASA — WAJIB:
- SELALU gunakan Bahasa Indonesia untuk SEMUA respons tanpa terkecuali
- JANGAN pernah beralih ke bahasa lain meskipun kandidat berbicara dalam bahasa asing

VALIDASI JAWABAN — PENTING:
- Jika jawaban kandidat tidak jelas, tidak terdengar, atau tampak bukan Bahasa Indonesia (misalnya teks acak, kata-kata asing yang tidak relevan, atau kalimat yang tidak masuk akal), JANGAN lanjutkan ke pertanyaan berikutnya
- Minta kandidat mengulang dengan sopan, gunakan salah satu variasi ini:
  * "Maaf, jawaban Anda kurang terdengar jelas. Boleh diulang kembali?"
  * "Mohon maaf, saya kurang menangkap jawaban Anda. Bisa disampaikan sekali lagi?"
  * "Sepertinya ada gangguan audio. Bisa tolong diulang jawabannya?"
- Jika setelah 2 kali pengulangan masih tidak jelas, catat sebagai "jawaban tidak terdengar" dan lanjut ke pertanyaan berikutnya

ATURAN INTERVIEW:
- Mulai dengan sapaan hangat dan perkenalan singkat
- Tanyakan pertanyaan berikut secara berurutan:
  1. Ceritakan tentang diri Anda dan pengalaman kerja terakhir
  2. Mengapa Anda tertarik dengan posisi ${job || 'ini'}?
  3. Apa kelebihan utama yang bisa Anda kontribusikan?
  4. Bagaimana Anda menangani tekanan atau situasi sulit di tempat kerja?
  5. Kapan Anda bisa mulai bekerja?
- Dengarkan jawaban kandidat, berikan respons singkat sebelum pertanyaan berikutnya
- Setelah semua pertanyaan dijawab, tanyakan: "Apakah ada yang ingin kamu tanyakan?"
- Jawab pertanyaan kandidat menggunakan DATABASE JAWABAN di bawah jika tersedia
- Jika tidak ada di database, katakan recruiter akan menjelaskan lebih detail nanti
- Setelah kandidat tidak ada pertanyaan lagi, ucapkan terima kasih dan tutup interview
- Jaga nada profesional namun ramah${fallbackFaq}`
  }

  return `You are a professional AI interviewer for the ${job || 'general'} position.
The candidate's name is ${name || 'candidate'}.

RULES:
- Conduct the interview in English
- Start with a warm greeting and brief introduction
- Ask these questions in order:
  1. Tell me about yourself and your most recent work experience
  2. Why are you interested in the ${job || 'this'} position?
  3. What key strengths can you contribute?
  4. How do you handle pressure or difficult situations at work?
  5. When can you start?
- Listen to the candidate's answers, give brief acknowledgment before the next question
- After all questions are answered, ask: "Do you have any questions about the position or company?"
- Answer candidate questions using the FAQ database if available
- If not in database, say the recruiter will explain in more detail later
- After candidate has no more questions, thank them and close the interview
- Keep a professional but friendly tone`
}

// POST /api/realtime/session
export async function handleRealtimeSession(req: Request): Promise<Response> {
  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  const { chat_id, job, name, lang } = body

  // Fetch interview questions + candidate FAQ from Google Sheets
  const [allQuestions, faq] = await Promise.all([fetchInterviewQuestions(), fetchCandidateFAQ()])
  const questions = filterQuestionsForJob(allQuestions, job ?? '')

  // Fetch candidate's collected answers from session storage (PostgreSQL)
  const collectedAnswers = await loadCollectedAnswers(chat_id)
  logger.info({ event: 'realtime_data_loaded', questions: questions.length, faq: faq.length, job, answers: Object.keys(collectedAnswers).length })

  const instructions = buildInstructions(name ?? '', job ?? '', lang ?? 'id', questions, faq, collectedAnswers)

  try {
    const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'coral',
        instructions,
        input_audio_transcription: { model: 'whisper-1', language: lang === 'id' ? 'id' : undefined },
        turn_detection: {
          type: 'server_vad',
          interrupt_response: false,
          create_response: true,
          threshold: 0.7,
          silence_duration_ms: 900,
          prefix_padding_ms: 300,
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      logger.error({ event: 'realtime_session_error', status: res.status, err })
      return Response.json({ error: 'Failed to create session' }, { status: 500 })
    }

    const session = await res.json()
    logger.info({ event: 'realtime_session_created', chat_id })
    return Response.json(session)
  } catch (err) {
    logger.error({ event: 'realtime_session_error', err })
    return Response.json({ error: 'Internal error' }, { status: 500 })
  }
}

// POST /api/realtime/complete (FormData: chat_id, job, name, duration_seconds, transcript JSON, audio file)
export async function handleRealtimeComplete(req: Request): Promise<Response> {
  let chat_id: string, job: string, name: string, duration_seconds: number
  let transcript: { role: string; text: string }[]
  let audioFile: File | null = null

  try {
    const form = await req.formData()
    chat_id = form.get('chat_id') as string ?? ''
    job = form.get('job') as string ?? ''
    name = form.get('name') as string ?? ''
    duration_seconds = Number(form.get('duration_seconds') ?? 0)
    transcript = JSON.parse(form.get('transcript') as string ?? '[]')
    audioFile = form.get('audio') as File | null
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  if (!chat_id || !transcript?.length) {
    return Response.json({ error: 'Missing data' }, { status: 400 })
  }

  const durationMin = Math.ceil(duration_seconds / 60)
  const transcriptText = transcript
    .map((t) => `${t.role === 'user' ? 'Kandidat' : 'AI'}: ${t.text}`)
    .join('\n')

  const summary = `AI Interview (${durationMin} min) — ${transcript.length} exchanges`
  let audioDriveUrl = ''

  logger.info({ event: 'realtime_complete', chat_id, job, duration: durationMin, exchanges: transcript.length, hasAudio: !!audioFile })

  // Save audio to local disk + Google Drive
  if (audioFile) {
    try {
      const dir = join('uploads', chat_id)
      mkdirSync(dir, { recursive: true })
      const localPath = join(dir, 'ai_interview.webm')
      const buffer = Buffer.from(await audioFile.arrayBuffer())
      writeFileSync(localPath, buffer)
      logger.info({ event: 'realtime_audio_saved', chat_id, path: localPath, size: buffer.length })

      // Upload to Google Drive
      const driveResult = await uploadToDrive(chat_id, localPath, 'cv') // reuse 'cv' type for any file
      if (driveResult.success) {
        audioDriveUrl = driveResult.driveUrl ?? ''
        logger.info({ event: 'realtime_audio_drive_uploaded', chat_id, url: audioDriveUrl })
      }
    } catch (err) {
      logger.error({ event: 'realtime_audio_save_error', chat_id, err })
    }
  }

  // Save to Google Sheets
  const notesWithAudio = audioDriveUrl
    ? `${summary}\nRecording: ${audioDriveUrl}\n\n${transcriptText}`
    : `${summary}\n\n${transcriptText}`

  try {
    await writeToSheets({ chat_id, status: 'qualified' }, { aiInterviewNotes: notesWithAudio })
    logger.info({ event: 'realtime_sheets_saved', chat_id })
  } catch (err) {
    logger.error({ event: 'realtime_sheets_error', chat_id, err })
  }

  // ── Interview scoring ────────────────────────────────────────────────────────
  let interviewScore: Awaited<ReturnType<typeof scoreInterviewTranscript>> | null = null
  try {
    interviewScore = await scoreInterviewTranscript(transcript)
    logger.info({ event: 'interview_scored', chat_id, score: interviewScore.totalScore, passed: interviewScore.passed })
    trackUsage(chat_id, 'gpt-4o', interviewScore.inputTokens, interviewScore.outputTokens)

    const snapshot = getSessionSnapshot(chat_id)
    const usageSummary = snapshot?.summary ?? undefined
    clearSession(chat_id)

    await writeToSheets(
      { chat_id, status: interviewScore.passed ? 'qualified' : 'rejected' },
      {
        aiInterviewNotes: notesWithAudio,
        interviewScore: String(interviewScore.totalScore),
        interviewScoreDetail: formatScoreDetail(interviewScore),
        usageSummary,
      },
    )

    if (snapshot) {
      writeUsageToSheet(chat_id, job ?? '', snapshot).catch((err) =>
        logger.error({ event: 'usage_sheet_write_error', chat_id, err })
      )
    }
  } catch (err) {
    logger.error({ event: 'interview_scoring_error', chat_id, err })
  }

  // ── Mark web session completed (persists on page reload) ─────────────────────
  if (chat_id.startsWith('web-')) {
    const { getOrCreateSession, saveSession } = await import('../../web/session')
    const webSess = getOrCreateSession(chat_id)
    webSess.state = 'interview_completed'
    saveSession(webSess)
  }

  // ── Notify candidate (Telegram only) ─────────────────────────────────────────
  if (!chat_id.startsWith('web-')) {
    try {
      const msg = `✅ *AI Interview selesai!*\n\n⏱ Durasi: ${durationMin} menit\n💬 ${transcript.length} pertanyaan & jawaban\n\n_"Terima kasih telah meluangkan waktu untuk mengikuti proses interview ini. Tim kami akan segera menghubungi Anda untuk informasi mengenai proses selanjutnya. Semoga sukses! 🙏"_`
      await bot.api.sendMessage(chat_id, msg, { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error({ event: 'realtime_notify_error', chat_id, err })
    }
  }

  return Response.json({
    success: true,
    summary,
    audioDriveUrl,
    score: interviewScore?.totalScore ?? null,
    passed: interviewScore?.passed ?? null,
  })
}

// GET /interview — serve Mini App HTML
export function serveInterviewPage(): Response {
  return new Response(INTERVIEW_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
