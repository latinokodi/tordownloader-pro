import { describe, it, expect } from 'vitest'
import { parseReleaseName, computeDestination } from '../../electron/media-layout'

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

  it('treats a leading 4-digit token as the title, not the year (show "1923")', () => {
    const r = parseReleaseName('1923.S02e01.2025.1080P-Dual-Lat.mkv')
    expect(r.title).toBe('1923')
    expect(r.year).toBe(2025)
    expect(r.season).toBe(2)
  })

  it('picks the year after the episode marker over the title digits', () => {
    const r = parseReleaseName('1883.S01E03.2021.1080p.WEB-DL.x264-GROUP')
    expect(r.title).toBe('1883')
    expect(r.year).toBe(2021)
    expect(r.season).toBe(1)
  })
})

describe('computeDestination (season folder layout)', () => {
  const settings = {
    destination_folder: 'D:\\Downloads',
    movies_folder: 'D:\\Movies',
    series_folder: 'D:\\Series',
    tmdb_api_key: '', // no network in tests → parsed title/year only
  }

  it('series: uses the DB season override when the release name has no Sxx marker', async () => {
    const r = await computeDestination(settings, 'La Casa de Papel 2017 T2E1 1080p LATINO', 'series', 2)
    expect(r.folder).toBe('La Casa de Papel (2017)/Season 02')
    expect(r.season).toBe(2)
  })

  it('series: prefers the DB season override over the parsed one', async () => {
    const r = await computeDestination(settings, 'Breaking.Bad.2008.S02E05.1080p.WEB-DL.x264-GROUP', 'series', 3)
    expect(r.folder).toBe('Breaking Bad (2008)/Season 03')
  })

  it('series: falls back to the Sxx marker in the name', async () => {
    const r = await computeDestination(settings, 'Breaking.Bad.2008.S02E05.1080p.WEB-DL.x264-GROUP', 'series')
    expect(r.folder).toBe('Breaking Bad (2008)/Season 02')
  })

  it('series: bare "S01" season-pack marker is picked up', async () => {
    const r = await computeDestination(settings, 'Show.Name.S01.1080p.WEB-DL.x264-GROUP', 'series')
    expect(r.folder).toBe('Show Name/Season 01')
  })

  it('series: defaults to Season 01 when nothing is parseable', async () => {
    const r = await computeDestination(settings, 'Una Serie 2024 1080p LATINO', 'series')
    expect(r.folder).toBe('Una Serie (2024)/Season 01')
  })

  it('series: numeric title "1923" keeps the show name and uses the real release year', async () => {
    const r = await computeDestination(settings, '1923.S02e01.2025.1080P-Dual-Lat.mkv', 'series', 2)
    expect(r.folder).toBe('1923 (2025)/Season 02')
    expect(r.season).toBe(2)
  })

  it('movie: no Season subfolder', async () => {
    const r = await computeDestination(settings, 'Inception.2010.1080p.BluRay.x264-AMIABLE', 'movie')
    expect(r.folder).toBe('Inception (2010)')
    expect(r.season).toBeUndefined()
  })
})
