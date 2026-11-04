import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { MAX_SYMBOLS, SYMBOLS, type Region, type VisualArchive } from './archive.js'
import type { Config } from './config.js'
import { imageBlock } from './content.js'
import { MAX_GUIDE_CHARS, MAX_WORKING_CHARS, type VistaMemory } from './memory.js'

interface ViewSelection {
  label: string
  visual?: string
  turn?: number
  frame?: number
  region?: Region
}

interface PixelSelection extends ViewSelection {
  region: Region
  rows: number
  columns: number
}

const REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
  },
} as const

const INSPECT_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    views: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          label: { type: 'string' as const },
          visual: { type: 'string' as const },
          turn: { type: 'number' as const },
          frame: { type: 'number' as const },
          width: { type: 'number' as const },
          height: { type: 'number' as const },
        },
      },
    },
  },
}

export function registerTools(
  ctx: Context,
  archive: VisualArchive,
  memory: VistaMemory,
  config: Config,
): void {
  //
  // inspect
  //
  // Image blocks are not JSON, so the canonical value is a JSON summary and
  // `finalizeContent` swaps in the prepared image blocks. The attachment refs
  // are created in `execute`, where async work is allowed.
  //
  const pendingInspection = new Map<string, ContentBlock[]>()

  ctx.tools.register(defineTool({
    name: 'inspect',
    description:
      'Revisit an image you have already seen and look at a selected region. ' +
      'Use this instead of asking for the whole image again. State the visual ' +
      'question this view should answer, and give every view a short label.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The visual question these views should settle.',
      },
      views: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true },
            visual: { type: 'string', description: 'Stable id such as v12.' },
            turn: { type: 'number', description: 'Archived visual event turn.' },
            frame: { type: 'number', description: 'Frame within the turn; omit for the final frame.' },
            region: REGION_SCHEMA,
          },
        },
      },
    },
    output: {
      schema: INSPECT_OUTPUT_SCHEMA,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: (value.views as any[])
            .map((view) => `[${view.label}] ${view.visual} ${view.width}x${view.height}`)
            .join('\n'),
        },
      ],
    },
    finalizeContent(exec) {
      const key = String(exec.callId)
      const blocks = pendingInspection.get(key)
      if (!blocks) return undefined
      pendingInspection.delete(key)
      return blocks
    },
    async execute(args, exec) {
      const input = args as unknown as { question: string; views: ViewSelection[] }
      if (input.views.length < 1 || input.views.length > config.maxInspectViews) {
        throw new Error(`inspect accepts 1..${config.maxInspectViews} views`)
      }
      if (!input.question.trim()) throw new Error('inspect requires a question')

      const summary = []
      const blocks: ContentBlock[] = []
      for (const view of input.views) {
        exec.signal.throwIfAborted()
        const resolved = await archive.resolveView(view)
        const visual = resolved.visual
        const crop = await archive.crop(visual.id, view.region)
        const block = await imageBlock(ctx, crop.data, 'image/png')

        blocks.push(
          { type: 'text', text: `[${view.label}] ${input.question}` },
          block,
        )
        summary.push({
          label: view.label,
          visual: visual.id,
          turn: resolved.turn,
          frame: resolved.frame,
          width: crop.width,
          height: crop.height,
        })
      }

      pendingInspection.set(String(exec.callId), blocks)
      return { views: summary }
    },
  }))

  //
  // read_pixels
  //
  ctx.tools.register(defineTool({
    name: 'read_pixels',
    description:
      'Read exact colors from a region of an image you have already seen. ' +
      'The region is divided into equal rows and columns; the centre pixel of ' +
      'each part is sampled. This tool only measures pixels; it does not ' +
      'interpret them.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'What this measurement is meant to settle.',
      },
      views: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true },
            visual: { type: 'string', description: 'Stable id such as v12.' },
            turn: { type: 'number', description: 'Archived visual event turn.' },
            frame: { type: 'number', description: 'Frame within the turn; omit for the final frame.' },
            region: { ...REGION_SCHEMA, required: true },
            rows: { type: 'number', required: true },
            columns: { type: 'number', required: true },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const input = args as unknown as { question: string; views: PixelSelection[] }
      if (input.views.length < 1 || input.views.length > config.maxPixelViews) {
        throw new Error(`read_pixels accepts 1..${config.maxPixelViews} views`)
      }

      let total = 0
      const measured = []
      for (const view of input.views) {
        exec.signal.throwIfAborted()
        if (view.rows < 1 || view.columns < 1) throw new Error('rows and columns must be positive')
        total += view.rows * view.columns
        if (total > config.maxPixelSamples) {
          throw new Error(`read_pixels accepts at most ${config.maxPixelSamples} samples per call`)
        }
        const resolved = await archive.resolveView(view)
        measured.push({
          label: view.label,
          visual: resolved.visual.id,
          ...(resolved.turn === undefined ? {} : { turn: resolved.turn }),
          ...(resolved.frame === undefined ? {} : { frame: resolved.frame }),
          ...(await archive.readPixels(resolved.visual.id, view.region, view.rows, view.columns)),
        })
      }

      // One palette per call, shared by every view in request order.
      const palette = new Map<string, string>()
      for (const view of measured) {
        for (const row of view.colors) {
          for (const color of row) {
            if (!palette.has(color)) {
              if (palette.size >= MAX_SYMBOLS) {
                throw new Error(`The pixel readout color limit (${MAX_SYMBOLS}) has been reached.`)
              }
              palette.set(color, SYMBOLS[palette.size] ?? '')
            }
          }
        }
      }

      return {
        question: input.question,
        palette: Object.fromEntries(
          [...palette.entries()].map(([color, symbol]) => [symbol, color]),
        ),
        views: measured.map((view) => ({
          label: view.label,
          visual: view.visual,
          rows: view.rows,
          columns: view.columns,
          samples: view.colors.map((row) => row.map((color) => palette.get(color) ?? '?').join('')),
        })),
      }
    },
  }))

  //
  // visuals
  //
  ctx.tools.register(defineTool({
    name: 'visuals',
    description:
      'List images you have already seen. Use this when you remember an image ' +
      'but no longer know its id.',
    parameters: {
      limit: {
        type: 'number',
        description: 'How many recent images to return. Default 20, maximum 100.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as unknown as { limit?: number }
      const requested = input.limit ?? 20
      const limit = Math.max(1, Math.min(100, Math.floor(requested)))
      return {
        visuals: archive.list(limit).map((visual) => ({
          visual: visual.id,
          source: visual.source,
          label: visual.label ?? null,
          width: visual.width,
          height: visual.height,
          at: visual.createdAt,
        })),
      }
    },
  }))

  //
  // history
  //
  ctx.tools.register(defineTool({
    name: 'history',
    description:
      'Read archived visual-bearing tool events by turn. Ranges include start_turn ' +
      'and exclude end_turn; omit both bounds for the most recent events.',
    parameters: {
      start_turn: { type: 'number' },
      end_turn: { type: 'number' },
      limit: { type: 'number', description: 'Default 64, maximum 128.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as unknown as {
        start_turn?: number
        end_turn?: number
        limit?: number
      }
      return {
        events: archive
          .history({
            startTurn: input.start_turn,
            endTurn: input.end_turn,
            limit: input.limit,
          })
          .map((event) => ({
            turn: event.turn,
            tool: event.tool,
            visuals: event.visuals.map((view) => ({
              visual: view.visual,
              frame: view.frame,
            })),
          })),
      }
    },
  }))

  //
  // register_image
  //
  ctx.tools.register(defineTool({
    name: 'register_image',
    description:
      'Register a local image path that was not archived automatically, then address it by visual or turn/frame.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path or path relative to the current workspace.' },
      label: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const path = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const visual = await archive.ingest(await readFile(path), {
        source: 'register_image',
        ...(args.label ? { label: args.label } : {}),
      })
      const event = await archive.recordEvent({ tool: 'register_image', visuals: [visual] })
      return {
        visual: visual.id,
        turn: event.turn,
        frame: 0,
        width: visual.width,
        height: visual.height,
      }
    },
  }))

  registerMemoryTools(ctx, memory)
}

function registerMemoryTools(ctx: Context, memory: VistaMemory): void {
  const textOutput = {
    schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { content: { type: 'string' as const } },
    },
    render: (_args: unknown, value: { content: string }) => [
      { type: 'text' as const, text: value.content || '(empty)' },
    ],
  }

  ctx.tools.register(defineTool({
    name: 'read_guide',
    description: 'Read durable visual-task knowledge from GUIDE.md.',
    parameters: {},
    output: textOutput,
    async execute() {
      return { content: await memory.readGuide() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'write_guide',
    description: 'Replace GUIDE.md with a complete durable visual-task model.',
    parameters: {
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'boolean' },
      render: () => [{ type: 'text', text: 'GUIDE.md updated.' }],
    },
    async execute(args) {
      if (args.content.length > MAX_GUIDE_CHARS) {
        throw new Error(`GUIDE.md exceeds ${MAX_GUIDE_CHARS} characters`)
      }
      await memory.writeGuide(args.content)
      return true
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_working',
    description: 'Read temporary continuation state from WORKING.md.',
    parameters: {},
    output: textOutput,
    async execute() {
      return { content: await memory.readWorking() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'write_working',
    description: 'Replace WORKING.md with the current plan and unresolved state.',
    parameters: {
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'boolean' },
      render: () => [{ type: 'text', text: 'WORKING.md updated.' }],
    },
    async execute(args) {
      if (args.content.length > MAX_WORKING_CHARS) {
        throw new Error(`WORKING.md exceeds ${MAX_WORKING_CHARS} characters`)
      }
      await memory.writeWorking(args.content)
      return true
    },
  }))

  ctx.tools.register(defineTool({
    name: 'save_compact_checkpoint',
    description:
      'Save compact continuation state. Set guide to null when durable knowledge did not change.',
    parameters: {
      guide: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
      },
      working_memory: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          guide_updated: { type: 'boolean' },
          working_updated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.guide_updated
          ? 'GUIDE.md and WORKING.md checkpointed.'
          : 'WORKING.md checkpointed; GUIDE.md unchanged.',
      }],
    },
    async execute(args) {
      const result = await memory.saveCheckpoint({
        guide: args.guide,
        workingMemory: args.working_memory,
      })
      return {
        guide_updated: result.guideUpdated,
        working_updated: result.workingUpdated,
      }
    },
  }))
}
