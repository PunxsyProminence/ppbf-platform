import type { IntakeClassification } from './types'

interface Rule {
  tokens: string[]
  detectedType: string
  destination: IntakeClassification['destination']
  route: string
  reason: string
}

const RULES: Rule[] = [
  {
    tokens: ['safety', 'incident', 'injury'],
    detectedType: 'Incident Note',
    destination: 'Incident / Safety Log',
    route: '/audit',
    reason: 'Matched safety and incident language',
  },
  {
    tokens: ['board', 'policy', 'governance'],
    detectedType: 'Board Document',
    destination: 'Board Hub',
    route: '/board',
    reason: 'Matched governance and board language',
  },
  {
    tokens: ['parent', 'guardian', 'family'],
    detectedType: 'Parent Observation',
    destination: 'Parent Hub',
    route: '/parent/dashboard',
    reason: 'Matched parent and guardian language',
  },
  {
    tokens: ['coach', 'session', 'training'],
    detectedType: 'Coach Note',
    destination: 'Coach Workspace',
    route: '/coach/review-queue',
    reason: 'Matched coach and training language',
  },
  {
    tokens: ['athlete', 'round', 'sparring', 'workout'],
    detectedType: 'Workout',
    destination: 'Athlete Workspace',
    route: '/athlete/dashboard',
    reason: 'Matched athlete and workout language',
  },
  {
    tokens: ['capability', 'roadmap', 'register'],
    detectedType: 'Policy Draft',
    destination: 'Capability Registry',
    route: '/admin',
    reason: 'Matched capability governance language',
  },
]

function scoreRule(text: string, rule: Rule): number {
  return rule.tokens.reduce((score, token) => (text.includes(token) ? score + 1 : score), 0)
}

export function classifyPdfText(rawText: string): IntakeClassification {
  const normalized = rawText.toLowerCase()

  const best = RULES
    .map((rule) => ({ rule, score: scoreRule(normalized, rule) }))
    .sort((a, b) => b.score - a.score)[0]

  if (!best || best.score === 0) {
    return {
      detectedType: 'File Intake',
      confidence: 'Low',
      destination: 'SHADOW Local State',
      destinationRoute: '/admin/shadow',
      reason: 'No strong domain tokens found',
    }
  }

  let confidence: IntakeClassification['confidence'] = 'Low'
  if (best.score >= 3) {
    confidence = 'High'
  } else if (best.score >= 2) {
    confidence = 'Medium'
  }

  return {
    detectedType: best.rule.detectedType,
    confidence,
    destination: best.rule.destination,
    destinationRoute: best.rule.route,
    reason: best.rule.reason,
  }
}
