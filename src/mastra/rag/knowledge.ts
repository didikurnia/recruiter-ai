import { createTool } from '@mastra/core/tools'
import { openai } from '@ai-sdk/openai'
import { PgVector } from '@mastra/pg'
import { embed } from 'ai'
import { z } from 'zod'
import { env } from '../../config/env'

const pgVector = new PgVector({ id: 'knowledge-query', connectionString: env.DATABASE_URL })

export const INDEX_NAME = 'job_embeddings'
export const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small')
export const EMBEDDING_DIMENSION = 1536

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * Custom job query tool that shuffles results so the listing order varies
 * each request. Wraps pgvector similarity search directly.
 */
export const jobQueryTool = createTool({
  id: 'jobQueryTool',
  description:
    'Search the job knowledge base for relevant job listings, requirements, benefits, and recruiter contacts. Use this for any candidate question about available jobs.',
  inputSchema: z.object({
    query: z.string().describe('The candidate question or job search query'),
    topK: z.number().optional().default(5).describe('Max results to return'),
  }),
  execute: async (inputData) => {
    const { query, topK = 5 } = inputData as { query: string; topK?: number }
    try {
      const { embedding } = await embed({ model: EMBEDDING_MODEL, value: query })
      const results = await pgVector.query({
        indexName: INDEX_NAME,
        queryVector: embedding,
        topK: topK + 3, // fetch a few extra so shuffle has more variety
      })
      const shuffled = shuffle(results).slice(0, topK)
      return {
        sources: shuffled.map((r) => ({
          text: (r.metadata?.text as string) ?? '',
          metadata: r.metadata ?? {},
          score: r.score,
        })),
      }
    } catch (err) {
      return { sources: [], error: String(err) }
    }
  },
})
