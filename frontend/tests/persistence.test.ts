import { beforeEach, describe, expect, it } from 'vitest'
import { isSharedSlotModelUrl } from '../../supabase/functions/_shared/modelKeys'
import { enqueue, flushOutbox, pendingSessionUpdates, retrying } from '../src/lib/outbox'

const S3 = 'https://infrastudio-ifc-models-343262620843.s3.eu-north-1.amazonaws.com'

describe('isSharedSlotModelUrl', () => {
  it('flags shared build-slot keys', () => {
    expect(isSharedSlotModelUrl(`${S3}/models/c21f969b/model.ifc?t=1`)).toBe(true)
    expect(isSharedSlotModelUrl(`${S3}/models/slot2/model.ifc`)).toBe(true)
  })
  it('accepts per-build and review copies and other hosts', () => {
    expect(isSharedSlotModelUrl(`${S3}/models/cd74cb9f-796c-401c-a7a0-764c11806485/model.ifc?t=1`)).toBe(false)
    expect(isSharedSlotModelUrl(`${S3}/models/review-UVRvVX7DU2x5/model.ifc`)).toBe(false)
    expect(isSharedSlotModelUrl('https://pzeoilvqeyuheslkfhjq.supabase.co/storage/v1/object/public/ifc-models/imports/a.ifc')).toBe(false)
    expect(isSharedSlotModelUrl(null)).toBe(false)
    expect(isSharedSlotModelUrl('not a url')).toBe(false)
  })
})

describe('outbox', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage
  })

  it('keeps a failed model link and sends it again later', async () => {
    enqueue({ kind: 'session', sessionId: 's1', updates: { last_ifc_url: 'u1' } })
    enqueue({ kind: 'message', sessionId: 's1', msg: { role: 'assistant', content: 'hi' } })
    expect(pendingSessionUpdates('s1')).toEqual({ last_ifc_url: 'u1' })

    await flushOutbox(async () => false) // still offline: nothing is lost
    expect(pendingSessionUpdates('s1')).toEqual({ last_ifc_url: 'u1' })

    const sent: string[] = []
    await flushOutbox(async (job) => {
      sent.push(job.kind)
      return true
    })
    expect(sent).toEqual(['session', 'message'])
    expect(pendingSessionUpdates('s1')).toEqual({})
  })

  it('retrying succeeds after a failure', async () => {
    let calls = 0
    const ok = await retrying(async () => ++calls >= 2, 3)
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })
})
