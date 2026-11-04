import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { VistaMemory } from '../lib/memory.js'

test('GUIDE, WORKING, and compact checkpoint survive reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vista-memory-'))
  try {
    const memory = new VistaMemory(directory)
    await memory.writeGuide('Durable map')
    await memory.writeWorking('Immediate plan')
    await memory.saveCheckpoint({
      guide: 'Revised durable map',
      workingMemory: 'Next: inspect turn 3 frame 1',
    })

    const reopened = new VistaMemory(directory)
    assert.equal(await reopened.readGuide(), 'Revised durable map\n')
    assert.equal(await reopened.readWorking(), 'Next: inspect turn 3 frame 1\n')

    await reopened.saveCheckpoint({
      guide: null,
      workingMemory: 'Next: compare turn 3 and turn 7',
    })
    assert.equal(await reopened.readGuide(), 'Revised durable map\n')
    assert.equal(await reopened.readWorking(), 'Next: compare turn 3 and turn 7\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
