/**
 * Loads dynamic data collection questions from "SPX Question" sheet (Category=Data_Needs).
 * Cached for 5 minutes to avoid hitting Sheets API on every conversation.
 */
import { google } from 'googleapis'
import { env, parseGoogleKey } from '../../config/env'
import { logger } from '../../logger'

export type DataFieldType = 'Text' | 'Boolean' | 'Number' | 'Date' | 'Upload Docs'

export interface DataNeedQuestion {
  questionNumber: string  // e.g. "Quesiton_1"
  question: string         // prompt text
  type: DataFieldType
  rules: string            // e.g. "16" for NIK length; for Upload Docs = number of pages required
  uploadCount: number      // for Upload Docs: how many pages to collect (parsed from rules, default 1)
  choices: string[]        // for Text with options
}

let cache: { data: DataNeedQuestion[]; expires: number } = { data: [], expires: 0 }

export async function loadDataNeeds(force = false): Promise<DataNeedQuestion[]> {
  if (!force && Date.now() < cache.expires && cache.data.length) return cache.data

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
    // Columns: A=Question_Number, B=Category, C=Question, D=Role, E=Jawaban, F=%, G=Type, H=Rules, I..M=Choises_1..5
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'SPX Question!A2:M100',
    })

    const data = (res.data.values ?? [])
      .filter((r: string[]) => r[1]?.trim() === 'Data_Needs' && r[2]?.trim())
      .map((r: string[]): DataNeedQuestion => {
        const choices = [r[8], r[9], r[10], r[11], r[12]]
          .map((c) => c?.trim() ?? '')
          .filter(Boolean)
        const rawType = (r[6]?.trim() ?? 'Text') as DataFieldType
        const type: DataFieldType = ['Text', 'Boolean', 'Number', 'Date', 'Upload Docs'].includes(rawType)
          ? rawType
          : 'Text'
        const rules = r[7]?.trim() ?? ''
        const uploadCount = type === 'Upload Docs' ? (Number.parseInt(rules, 10) || 1) : 1
        return {
          questionNumber: r[0]?.trim() ?? '',
          question: r[2]?.trim() ?? '',
          type,
          rules,
          uploadCount,
          choices,
        }
      })

    cache = { data, expires: Date.now() + 5 * 60 * 1000 }
    logger.info({ event: 'data_needs_loaded', count: data.length })
    return data
  } catch (err) {
    logger.error({ event: 'data_needs_load_error', err })
    return cache.data
  }
}

/** Validate input based on field type and rules */
export function validateAnswer(q: DataNeedQuestion, value: string): { valid: boolean; error?: string; parsed?: string } {
  const v = value.trim()
  if (!v) return { valid: false, error: 'Mohon diisi.' }

  if (q.type === 'Number') {
    if (!/^\d+$/.test(v)) return { valid: false, error: 'Harus berupa angka.' }
    if (q.rules) {
      const expected = parseInt(q.rules, 10)
      if (!isNaN(expected) && v.length !== expected) {
        return { valid: false, error: `Harus ${expected} digit. Anda mengetik ${v.length} digit.` }
      }
    }
    return { valid: true, parsed: v }
  }

  if (q.type === 'Boolean') {
    const yes = ['ya', 'yes', 'sudah', 'pernah', 'benar', 'iya', 'y', 'ok']
    const no = ['tidak', 'no', 'belum', 'ga', 'gak', 'n', 'nggak']
    const low = v.toLowerCase()
    if (yes.some((w) => low === w || low.startsWith(w + ' '))) return { valid: true, parsed: 'Ya' }
    if (no.some((w) => low === w || low.startsWith(w + ' '))) return { valid: true, parsed: 'Tidak' }
    return { valid: false, error: 'Mohon jawab dengan "ya" atau "tidak".' }
  }

  if (q.type === 'Date') {
    // Accept DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
    if (!/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$|^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
      return { valid: false, error: 'Format tanggal salah. Contoh: 25/12/1995' }
    }
    return { valid: true, parsed: v }
  }

  // Text: check choices if provided (but be lenient — allow partial match)
  if (q.choices.length > 0) {
    const match = q.choices.find((c) => c.toLowerCase() === v.toLowerCase())
    if (match) return { valid: true, parsed: match }
    // Allow free text but note it doesn't match
    return { valid: true, parsed: v }
  }

  return { valid: true, parsed: v }
}

/** Build prompt text for a question */
export function buildPrompt(q: DataNeedQuestion, index: number, total: number, uploadPage = 1): string {
  let prompt = `📝 <b>Pertanyaan ${index + 1}/${total}</b>\n\n${q.question}`

  if (q.type === 'Boolean') {
    prompt += '\n\n<i>Jawab: ya / tidak</i>'
  } else if (q.type === 'Number') {
    const digits = q.rules ? ` (${q.rules} digit)` : ''
    prompt += `\n\n<i>Ketik angka${digits}</i>`
  } else if (q.type === 'Date') {
    prompt += '\n\n<i>Format: DD/MM/YYYY (contoh: 25/12/1995)</i>'
  } else if (q.type === 'Upload Docs') {
    if (q.uploadCount > 1) {
      prompt += `\n\n<i>Upload halaman ${uploadPage} dari ${q.uploadCount} (gambar/PDF, maks 20MB)</i>`
    } else {
      prompt += '\n\n<i>Upload file (gambar/PDF, maks 20MB)</i>'
    }
  } else if (q.choices.length > 0) {
    prompt += `\n\n<i>Pilihan: ${q.choices.join(' / ')}</i>`
  }

  return prompt
}
