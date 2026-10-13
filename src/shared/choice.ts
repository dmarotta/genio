import type { Decision } from './types'

/** Only explicit recommendations are eligible for a reviewed batch. */
export function recommendationAnswer(d: Decision): string | undefined {
  return d.recommendation?.trim() || undefined
}

export function choiceGroup(d: Decision): string {
  return JSON.stringify([d.wksp, d.project ?? '', d.batch ? ['batch', d.batch] : ['task', d.taskId ?? d.backlogId ?? d.id]])
}

/** Content token: a changed question, answer, scope or deferral invalidates review. */
export function choiceRevision(d: Decision): string {
  return JSON.stringify([d.id, d.revision ?? 0, d.question, d.context, d.options, d.recommendation, d.wksp, d.project, d.taskId, d.backlogId, d.batch, d.until, d.resolvedAt, d.action, d.clarifications])
}

export interface RecommendationReview {
  id: string
  group: string
  revision: string
  answer: string
}

export interface RecommendationResult {
  id: string
  ok: boolean
  message: string
}

export function reviewRecommendation(d: Decision): RecommendationReview | undefined {
  const answer = recommendationAnswer(d)
  return answer ? { id: d.id, group: choiceGroup(d), revision: choiceRevision(d), answer } : undefined
}
