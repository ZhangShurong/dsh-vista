import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const MAX_GUIDE_CHARS = 64 * 1024
export const MAX_WORKING_CHARS = 16 * 1024

export function resolveMemoryDir(archiveDir: string, workspace = process.cwd()): string {
  const key = createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16)
  return join(archiveDir, 'memory', key)
}

export class VistaMemory {
  private readonly guidePath: string
  private readonly workingPath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {
    this.guidePath = join(directory, 'GUIDE.md')
    this.workingPath = join(directory, 'WORKING.md')
  }

  async readGuide(): Promise<string> {
    return readOptional(this.guidePath)
  }

  async readWorking(): Promise<string> {
    return readOptional(this.workingPath)
  }

  async writeGuide(content: string): Promise<void> {
    const normalized = normalizeMemory(content, 'GUIDE.md', MAX_GUIDE_CHARS)
    await this.enqueue(() => atomicWriteText(this.directory, this.guidePath, normalized))
  }

  async writeWorking(content: string): Promise<void> {
    const normalized = normalizeMemory(content, 'WORKING.md', MAX_WORKING_CHARS)
    await this.enqueue(() => atomicWriteText(this.directory, this.workingPath, normalized))
  }

  async saveCheckpoint(input: { guide: string | null; workingMemory: string }): Promise<{
    guideUpdated: boolean
    workingUpdated: true
  }> {
    const guide = input.guide === null
      ? null
      : normalizeMemory(input.guide, 'GUIDE.md', MAX_GUIDE_CHARS)
    const working = normalizeMemory(input.workingMemory, 'WORKING.md', MAX_WORKING_CHARS)
    await this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if (guide !== null) await atomicWriteText(this.directory, this.guidePath, guide)
      await atomicWriteText(this.directory, this.workingPath, working)
    })
    return { guideUpdated: guide !== null, workingUpdated: true }
  }

  private async enqueue(write: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(write, write)
    await this.writeChain
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function normalizeMemory(content: string, name: string, maximum: number): string {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${name} content must be non-empty`)
  }
  if (content.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`)
  return `${content.trim()}\n`
}

async function atomicWriteText(directory: string, path: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.vista-memory-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
