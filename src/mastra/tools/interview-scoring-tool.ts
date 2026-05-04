/**
 * Interview scoring engine.
 *
 * Loads the scoring rubric from:
 *   - Scoring sheet  → which questions count + their weights (Bobot)
 *   - SPX Question sheet → question text + expected answer per question ID
 *
 * Then uses AI (GPT-4o) to extract the candidate's relevant answer from the
 * transcript and score it 0–100 against the expected answer.
 *
 * Final score = Σ (ai_score/100 * bobot)  →  0–100
 * Pass threshold: ≥ 60
 */
import { google } from 'googleapis'
import { generateObject } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'
import { env, parseGoogleKey } from '../../config/env'
import { logger } from '../../logger'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoringRubricItem {
  questionId: string     // e.g. "Interview_5"
  question: string
  expectedAnswer: string
  passingThreshold: number  // e.g. 0.60 from "60%"
  weight: number         // e.g. 0.20 from Bobot "20"
}

export interface AnswerScore {
  questionId: string
  question: string
  candidateAnswer: string
  aiScore: number        // 0–100 raw AI score
  analysis: string       // AI reasoning for the score
  passed: boolean
  contribution: number   // (aiScore / 100) * weight * 100 → points toward final
}

export interface InterviewScoreResult {
  totalScore: number     // 0–100
  passed: boolean
  breakdown: AnswerScore[]
}

// ─── Google Sheets auth ───────────────────────────────────────────────────────

function createSheetsClient() {
  const key = parseGoogleKey()
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  return google.sheets({ version: 'v4', auth })
}

// ─── Load scoring rubric ──────────────────────────────────────────────────────

export async function loadScoringRubric(): Promise<ScoringRubricItem[]> {
  const spreadsheetId = env.GOOGLE_JOBS_SPREADSHEET_ID
  const sheets = createSheetsClient()

  // 1. Load Scoring sheet: Number | Subsheet | Bobot
  const scoringRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Scoring!A2:C100',
  })
  const scoringRows = (scoringRes.data.values ?? []) as string[][]

  // 2. Load SPX Question sheet: Question_Number | Category | Question | Role | Jawaban yang Diharapkan | Persentage jawaban | ...
  const spxRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'SPX Question!A2:F200',
  })
  const spxRows = (spxRes.data.values ?? []) as string[][]

  // Build lookup: questionId → { question, expectedAnswer, passingThreshold }
  const spxMap = new Map<string, { question: string; expectedAnswer: string; passingThreshold: number }>()
  for (const r of spxRows) {
    const id = r[0]?.trim()
    if (!id) continue
    const pctStr = r[5]?.replace('%', '').trim()
    spxMap.set(id, {
      question: r[2]?.trim() ?? '',
      expectedAnswer: r[4]?.trim() ?? '',
      passingThreshold: pctStr ? Number(pctStr) / 100 : 0.6,
    })
  }

  // Build rubric
  const rubric: ScoringRubricItem[] = []
  for (const r of scoringRows) {
    const questionId = r[0]?.trim()
    const weight = Number(r[2]?.trim() ?? 0)
    if (!questionId || !weight) continue

    const spx = spxMap.get(questionId)
    if (!spx) {
      logger.warn({ event: 'scoring_rubric_missing_question', questionId })
      continue
    }

    rubric.push({
      questionId,
      question: spx.question,
      expectedAnswer: spx.expectedAnswer,
      passingThreshold: spx.passingThreshold,
      weight: weight / 100,
    })
  }

  return rubric
}

// ─── AI scoring ───────────────────────────────────────────────────────────────

const answerScoreSchema = z.object({
  items: z.array(z.object({
    questionId: z.string(),
    candidateAnswer: z.string().describe('The exact answer the candidate gave, extracted from transcript. Empty string if not answered.'),
    score: z.number().min(0).max(100).describe('How well the answer matches the expected answer. 0 = completely wrong/not answered, 100 = perfect match.'),
    analysis: z.string().describe('1–2 sentence explanation of why this score was given. In Indonesian. Mention what the candidate said and how it compares to the expected answer.'),
  })),
})

async function scoreWithAI(
  transcript: string,
  rubric: ScoringRubricItem[],
): Promise<{ scores: Map<string, { candidateAnswer: string; score: number; analysis: string }>; inputTokens: number; outputTokens: number }> {
  const questionList = rubric.map((r) =>
    `- ID: ${r.questionId}\n  Pertanyaan: "${r.question}"\n  Jawaban yang diharapkan: "${r.expectedAnswer}"`
  ).join('\n\n')

  const { object, usage } = await generateObject({
    model: openai('gpt-4o'),
    output: 'object',
    schema: answerScoreSchema,
    prompt: `Kamu adalah evaluator interview yang objektif. Analisis transkrip interview berikut dan nilai jawaban kandidat untuk setiap pertanyaan yang ditentukan.

TRANSKRIP:
${transcript}

PERTANYAAN YANG HARUS DINILAI:
${questionList}

INSTRUKSI PENILAIAN:
- Cari jawaban kandidat yang relevan dengan setiap pertanyaan di atas
- Nilai 0–100 seberapa baik jawaban kandidat sesuai dengan jawaban yang diharapkan
- 0 = tidak menjawab atau salah total
- 50–70 = menjawab sebagian / kurang lengkap
- 80–100 = menjawab dengan baik sesuai ekspektasi
- Jika pertanyaan tidak ditanyakan dalam interview, beri nilai 0, candidateAnswer = "", analysis = "Pertanyaan tidak terjawab dalam sesi interview."
- Untuk setiap pertanyaan, tulis analisis singkat (1–2 kalimat) dalam Bahasa Indonesia yang menjelaskan kenapa skor tersebut diberikan`,
  })

  const scores = new Map<string, { candidateAnswer: string; score: number; analysis: string }>()
  for (const item of object.items) {
    scores.set(item.questionId, { candidateAnswer: item.candidateAnswer, score: item.score, analysis: item.analysis })
  }
  return { scores, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface InterviewScoreResultWithUsage extends InterviewScoreResult {
  inputTokens: number
  outputTokens: number
}

export async function scoreInterviewTranscript(
  transcriptLines: { role: string; text: string }[],
): Promise<InterviewScoreResultWithUsage> {
  const transcriptText = transcriptLines
    .map((t) => `${t.role === 'user' ? 'Kandidat' : 'AI Interviewer'}: ${t.text}`)
    .join('\n')

  const rubricItems = await loadScoringRubric()
  const { scores: aiScores, inputTokens, outputTokens } = await scoreWithAI(transcriptText, rubricItems)
  const breakdown: AnswerScore[] = []

  for (const item of rubricItems) {
    const scored = aiScores.get(item.questionId)
    const aiScore = scored?.score ?? 0
    const candidateAnswer = scored?.candidateAnswer ?? ''
    const analysis = scored?.analysis ?? ''
    const contribution = (aiScore / 100) * item.weight * 100

    breakdown.push({
      questionId: item.questionId,
      question: item.question,
      candidateAnswer,
      aiScore,
      analysis,
      passed: aiScore >= item.passingThreshold * 100,
      contribution: Math.round(contribution * 10) / 10,
    })
  }

  const totalScore = Math.round(breakdown.reduce((sum, b) => sum + b.contribution, 0))

  return {
    totalScore,
    passed: totalScore >= 60,
    breakdown,
    inputTokens,
    outputTokens,
  }
}

// ─── Detail formatter (for Sheets column) ────────────────────────────────────

export function formatScoreDetail(result: InterviewScoreResult): string {
  const header = `Hasil AI Interview: ${result.totalScore}/100 | ${result.passed ? 'LULUS ✅' : 'TIDAK LULUS ❌'}\n\n`

  const rows = result.breakdown.map((b) => {
    const icon = b.passed ? '✅' : '❌'
    const score = `${b.aiScore}/100 (kontribusi: ${b.contribution})`
    const answer = b.candidateAnswer ? `Jawaban: "${b.candidateAnswer}"` : 'Jawaban: (tidak terjawab)'
    return [
      `${icon} ${b.question} — ${score}`,
      answer,
      `Analisis: ${b.analysis}`,
    ].join('\n')
  })

  return header + rows.join('\n\n')
}
