import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { VisualArchive } from '../lib/archive.js'
import { VistaMemory } from '../lib/memory.js'
import { registerTools } from '../lib/tools.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('visual history resolves archived frames by turn through registered tools', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'dsh-vista-history-'))
  const config = {
    archiveDir,
    displaySize: 4,
    maxInspectViews: 8,
    maxPixelViews: 16,
    maxPixelSamples: 4096,
    annotate: true,
    retentionDays: 0,
  }

  try {
    const archive = new VisualArchive(config)
    await archive.open()
    const visual = await archive.ingest(ONE_PIXEL_PNG, { source: 'experiment:frame' })
    const event = await archive.recordEvent({ tool: 'observe', visuals: [visual] })
    assert.equal(event.turn, 0)
    assert.deepEqual(await archive.history(), [
      {
        turn: 0,
        tool: 'observe',
        visuals: [{ visual: 'v1', frame: 0 }],
      },
    ])
    assert.equal((await archive.resolveView({ turn: 0 })).visual.id, 'v1')

    const registered = []
    const memory = new VistaMemory(archiveDir)
    const ctx = {
      tools: { register(tool) { registered.push(tool) } },
      attachments: {},
    }
    registerTools(ctx, archive, memory, config)
    assert.deepEqual(
      registered.map((tool) => tool.name),
      [
        'inspect',
        'read_pixels',
        'visuals',
        'history',
        'register_image',
        'read_guide',
        'write_guide',
        'read_working',
        'write_working',
        'save_compact_checkpoint',
      ],
    )

    const imagePath = join(archiveDir, 'registered.png')
    await writeFile(imagePath, ONE_PIXEL_PNG)
    const registration = await registered.find((tool) => tool.name === 'register_image').execute(
      { path: imagePath, label: 'fixture' },
      { signal: AbortSignal.timeout(1_000) },
    )
    assert.equal(registration.visual, 'v1')
    assert.equal(registration.turn, 1)
  } finally {
    await rm(archiveDir, { recursive: true, force: true })
  }
})
