import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CacheConfig } from './types.js'

interface StoredRecord<T> {
  version: 1
  createdAt: string
  value: T
}

export class ScoreCache<T> {
  private readonly memory = new Map<string, T>()
  private readonly inflight = new Map<string, Promise<T>>()

  constructor(private readonly config: CacheConfig) {}

  async get(key: string): Promise<T | undefined> {
    const memory = this.memory.get(key)
    if (memory !== undefined) {
      this.touch(key, memory)
      return memory
    }
    if (!this.config.enabled) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.pathFor(key), 'utf8')) as StoredRecord<T>
      if (parsed.version !== 1) return undefined
      this.touch(key, parsed.value)
      return parsed.value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
  }

  async set(key: string, value: T): Promise<void> {
    this.touch(key, value)
    if (!this.config.enabled) return
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    const record: StoredRecord<T> = {
      version: 1,
      createdAt: new Date().toISOString(),
      value,
    }
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async getOrCompute(key: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get(key)
    if (cached !== undefined) return { value: cached, hit: true }
    const existing = this.inflight.get(key)
    if (existing) return { value: await existing, hit: true }
    const promise = compute()
    this.inflight.set(key, promise)
    try {
      const value = await promise
      await this.set(key, value)
      return { value, hit: false }
    } finally {
      this.inflight.delete(key)
    }
  }

  private pathFor(key: string): string {
    const safe = key.replace(/[^a-fA-F0-9_-]/g, '_')
    return join(this.config.directory, safe.slice(0, 2), `${safe}.json`)
  }

  private touch(key: string, value: T): void {
    this.memory.delete(key)
    this.memory.set(key, value)
    while (this.memory.size > this.config.memoryEntries) {
      const oldest = this.memory.keys().next().value as string | undefined
      if (!oldest) break
      this.memory.delete(oldest)
    }
  }
}
