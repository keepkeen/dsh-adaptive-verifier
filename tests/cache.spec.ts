import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScoreCache } from '../src/cache.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('score cache', () => {
  it('persists values without storing prompt keys as filenames verbatim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'av-cache-'))
    directories.push(directory)
    const cache = new ScoreCache<{ score: number }>({ enabled: true, directory, memoryEntries: 10 })
    await cache.set('abcdef123456', { score: 0.9 })
    const second = new ScoreCache<{ score: number }>({ enabled: true, directory, memoryEntries: 10 })
    await expect(second.get('abcdef123456')).resolves.toEqual({ score: 0.9 })
  })

  it('deduplicates concurrent computations', async () => {
    const cache = new ScoreCache<number>({ enabled: false, directory: '.', memoryEntries: 10 })
    let calls = 0
    const compute = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); return 7 }
    const [a, b] = await Promise.all([cache.getOrCompute('x', compute), cache.getOrCompute('x', compute)])
    expect(a.value).toBe(7)
    expect(b.value).toBe(7)
    expect(calls).toBe(1)
  })
})
