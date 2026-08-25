import { describe, it, expect } from 'vitest'
import { parseReleaseName } from '../../electron/media-layout'

describe('parseReleaseName (season-download rename source)', () => {
  it('extracts title + season from a series release', () => {
    const r = parseReleaseName('Breaking.Bad.2008.S01E02.1080p.WEB-DL.x264-GROUP')
    expect(r.title).toBe('Breaking Bad')
    expect(r.year).toBe(2008)
    expect(r.season).toBe(1)
  })

  it('strips quality tags and release group from a movie name', () => {
    const r = parseReleaseName('Inception.2010.1080p.BluRay.x264-AMIABLE')
    expect(r.title).toBe('Inception')
    expect(r.year).toBe(2010)
  })

  it('handles a latino-style name with no episode marker', () => {
    const r = parseReleaseName('La Casa de Papel 2017 1080p LATINO')
    expect(r.title.toLowerCase()).toContain('la casa de papel')
    expect(r.year).toBe(2017)
    expect(r.season).toBeUndefined()
  })
})
