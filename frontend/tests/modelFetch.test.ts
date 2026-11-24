import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { gunzip, gzipSiblingUrl } from '../src/lib/modelFetch'

describe('gzipSiblingUrl', () => {
  it('adds .gz to a stored model url and keeps the cache query', () => {
    expect(
      gzipSiblingUrl('https://b.s3.eu-north-1.amazonaws.com/models/cd74cb9f-796c-401c-a7a0-764c11806485/model.ifc?t=17'),
    ).toBe('https://b.s3.eu-north-1.amazonaws.com/models/cd74cb9f-796c-401c-a7a0-764c11806485/model.ifc.gz?t=17')
  })
  it('ignores other hosts and other paths', () => {
    expect(gzipSiblingUrl('https://example.com/models/abc/model.ifc')).toBeNull()
    // shared slot keys are overwritten by later builds, so they never use a gzip copy
    expect(gzipSiblingUrl('https://b.s3.eu-north-1.amazonaws.com/models/c21f969b/model.ifc')).toBeNull()
    expect(gzipSiblingUrl('https://b.s3.eu-north-1.amazonaws.com/other/file.ifc')).toBeNull()
    expect(gzipSiblingUrl('not a url')).toBeNull()
  })
})

describe('gunzip', () => {
  it('returns the original bytes', async () => {
    const text = 'ISO-10303-21;\nHEADER;\n' + '#1=IFCWALL();\n'.repeat(500)
    const gz = gzipSync(Buffer.from(text))
    const out = await gunzip(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer)
    expect(new TextDecoder().decode(out)).toBe(text)
  })
})
