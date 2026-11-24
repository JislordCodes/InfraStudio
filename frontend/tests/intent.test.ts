import { describe, expect, it } from 'vitest'
import { classifyIntent } from '../../supabase/functions/_shared/intent'

const questions = [
  'how many walls does it have?',
  'What is the height of the roof',
  'why is the ground floor so small?',
  'is the staircase code compliant?',
  'can you tell me how many doors there are',
  'explain how the roof was built',
  'which material did you use for the columns',
  'does it have a basement?',
  'how do I add a door?',
  'what about the structure?',
]

const actions = [
  'add a swimming pool',
  'make the roof flat',
  'can you add a door to the kitchen?',
  'could you please make it taller',
  'please change the walls to brick',
  'I want you to move the stairs',
  'build a three storey office',
  'now paint the facade white',
  'Remove the second floor balcony',
  'let us widen the corridor',
  'the roof is too low',
  '',
]

describe('classifyIntent', () => {
  for (const q of questions) it(`question: ${q}`, () => expect(classifyIntent(q)).toBe('question'))
  for (const a of actions) it(`action: ${a || '(empty)'}`, () => expect(classifyIntent(a)).toBe('action'))
})
