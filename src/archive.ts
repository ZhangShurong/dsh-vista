import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import type { Config } from './config.js'

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export interface VisualMeta {
  source: string
  label?: string
  callId?: string
}

export interface StoredVisual {
  /** Stable model-facing id, e.g. "v12". */
  id: string
  sha256: string
  path: string
  mimeType: string
  width: number
  height: number
  source: string
  label?: string
  createdAt: string
}

export interface PixelView {
  rows: number
  columns: number
  /** Hex colors, one row per sampled row. */
  colors: string[][]
}

export const SYMBOLS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'
export const MAX_SYMBOLS = SYMBOLS.length

const EXTENSIONS: Record<string, string> = {
  png: '.png',
  jpeg: '.jpg',
  jpg: '.jpg',
  webp: '.webp',
  gif: '.gif',
}

/**
 * Host-side visual archive.
 *
 * DSH's attachment service owns the images that reach the model. This archive
 * keeps a second, stable, addressable copy so an image can be revisited after
 * it falls out of the model context. That duplication is intentional: visual
 * ids must survive compaction and image offload.
 */
export class VisualArchive {
  private readonly bySha = new Map<string, StoredVisual>()
  private readonly byId = new Map<string, StoredVisual>()
  private readonly indexPath: string
  private nextId = 1
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly config: Config) {
    this.indexPath = join(config.archiveDir, 'index.jsonl')
  }

  async open(): Promise<void> {
    await mkdir(this.config.archiveDir, { recursive: true, mode: 0o700 })

    let raw = ''
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const visual = JSON.parse(line) as StoredVisual
        if (!visual.id || !visual.sha256 || !visual.path) continue
        this.bySha.set(visual.sha256, visual)
        this.byId.set(visual.id, visual)
        this.nextId = Math.max(this.nextId, Number(visual.id.slice(1)) + 1)
      } catch {
        // A torn final line should not make the whole archive unreadable.
      }
    }

    if (this.config.retentionDays > 0) await this.sweep()
  }

  /** Store bytes once and return the existing visual for a duplicate hash. */
  async ingest(bytes: Buffer, meta: VisualMeta): Promise<StoredVisual> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = this.bySha.get(sha256)
    if (existing) return existing

    const metadata = await sharp(bytes).metadata()
    const width = metadata.width
    const height = metadata.height
    if (!width || !height) throw new Error('Image has no intrinsic dimensions')

    const extension = EXTENSIONS[metadata.format ?? ''] ?? '.png'
    const path = join(this.config.archiveDir, `${sha256}${extension}`)
    try {
      await access(path, constants.R_OK)
    } catch {
      await writeFile(path, bytes, { mode: 0o400 })
    }

    const visual: StoredVisual = {
      id: `v${this.nextId++}`,
      sha256,
      path,
      mimeType: `image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format ?? 'png'}`,
      width,
      height,
      source: meta.source,
      ...(meta.label ? { label: meta.label } : {}),
      createdAt: new Date().toISOString(),
    }

    this.bySha.set(sha256, visual)
    this.byId.set(visual.id, visual)
    this.appendIndex(visual)
    return visual
  }

  get(id: string): StoredVisual | undefined {
    return this.byId.get(id)
  }

  list(limit = 20): StoredVisual[] {
    const values = [...this.byId.values()]
    return values.slice(Math.max(0, values.length - limit))
  }

  async read(id: string): Promise<Buffer> {
    const visual = this.require(id)
    return readFile(visual.path)
  }

  /** Crop from the archived original and enlarge with nearest-neighbour. */
  async crop(id: string, region?: Region): Promise<{ data: Buffer; width: number; height: number }> {
    const visual = this.require(id)
    const box = clampRegion(region, visual.width, visual.height)
    let image = sharp(visual.path).extract({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
    })
    const longest = Math.max(box.width, box.height)
    if (longest < this.config.displaySize) {
      const scale = this.config.displaySize / longest
      image = image.resize({
        width: Math.max(1, Math.round(box.width * scale)),
        height: Math.max(1, Math.round(box.height * scale)),
        kernel: 'nearest',
      })
    }
    const { data, info } = await image.png().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  }

  /** Equal-bin-centre sampling, returning one symbol string per row. */
  async readPixels(id: string, region: Region, rows: number, columns: number): Promise<PixelView> {
    const visual = this.require(id)
    const box = clampRegion(region, visual.width, visual.height)
    const { data, info } = await sharp(visual.path)
      .extract({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const colors: string[][] = []
    for (let row = 0; row < rows; row++) {
      const line: string[] = []
      const y = Math.min(info.height - 1, Math.floor(((2 * row + 1) * info.height) / (2 * rows)))
      for (let column = 0; column < columns; column++) {
        const x = Math.min(info.width - 1, Math.floor(((2 * column + 1) * info.width) / (2 * columns)))
        const offset = (y * info.width + x) * info.channels
        line.push(
          `#${hex(data[offset] ?? 0)}${hex(data[offset + 1] ?? 0)}${hex(data[offset + 2] ?? 0)}`,
        )
      }
      colors.push(line)
    }

    return { rows, columns, colors }
  }

  close(): void {
    // Archive writes are already serialized; nothing to flush.
  }

  private require(id: string): StoredVisual {
    const visual = this.byId.get(id)
    if (!visual) throw new Error(`Unknown visual id: ${id}`)
    return visual
  }

  private appendIndex(visual: StoredVisual): void {
    const line = `${JSON.stringify(visual)}\n`
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(this.indexPath, line, { flag: 'a', mode: 0o600 })
    })
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.config.retentionDays * 86_400_000
    for (const visual of [...this.byId.values()]) {
      if (Date.parse(visual.createdAt) >= cutoff) continue
      this.byId.delete(visual.id)
      this.bySha.delete(visual.sha256)
      try {
        await unlink(visual.path)
      } catch {
        // Another archive may share the object; leaving it is harmless.
      }
    }
  }
}

function clampRegion(region: Region | undefined, width: number, height: number): Region {
  if (!region) return { x: 0, y: 0, width, height }
  const x = Math.max(0, Math.min(width - 1, Math.floor(region.x)))
  const y = Math.max(0, Math.min(height - 1, Math.floor(region.y)))
  const w = Math.max(1, Math.min(width - x, Math.floor(region.width)))
  const h = Math.max(1, Math.min(height - y, Math.floor(region.height)))
  return { x, y, width: w, height: h }
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}
