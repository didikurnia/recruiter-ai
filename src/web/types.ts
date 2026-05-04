import type { WebFsmState, WebJobListing } from './session'

export interface WebQuestion {
  questionNumber: string
  text: string
  type: 'Text' | 'Number' | 'Date' | 'Boolean' | 'Upload Docs'
  choices?: string[]
  rules?: string
  uploadCount?: number
}

export interface WebApiResponse {
  state: WebFsmState
  messages: string[]           // Bot messages to render in sequence
  // --- data_collection / file_upload ---
  question?: WebQuestion
  questionIndex?: number
  totalQuestions?: number
  uploadPage?: number
  uploadCount?: number
  // --- consent ---
  appliedJob?: string
  appliedJobLocation?: string
  // --- scoring / pass / fail ---
  score?: number
  passed?: boolean
  interviewUrl?: string
  failReason?: string
}
