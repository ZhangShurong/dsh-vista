import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { registerAnnotator } from '../lib/annotate.js'
import { VisualArchive } from '../lib/archive.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('annotator records one turn with an ordered frame for every delivered image', async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), 'dsh-vista-annotate-'))
  const imagePath = join(archiveDir, 'source.png')
  await writeFile(imagePath, ONE_PIXEL_PNG)
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
    let handler
    const ctx = {
      on(event, registered) {
        assert.equal(event, 'tools/post-execute')
        handler = registered
      },
      attachments: {
        imageHostPath() { return imagePath },
      },
    }
    registerAnnotator(ctx, archive, config)

    const result = await handler(
      { name: 'screenshot', callId: 'call-1' },
      {
        content: [
          { type: 'image', attachment: { id: 'first' } },
          { type: 'image', attachment: { id: 'second' } },
        ],
      },
      async () => ({ kind: 'accept' }),
    )

    assert.equal(result.kind, 'accept')
    assert.equal(result.content.filter((block) => block.type === 'image').length, 2)
    assert.deepEqual(archive.history(), [
      {
        turn: 0,
        tool: 'screenshot',
        visuals: [
          { visual: 'v1', frame: 0 },
          { visual: 'v1', frame: 1 },
        ],
      },
    ])
  } finally {
    await rm(archiveDir, { recursive: true, force: true })
  }
})
