import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { MAX_SYMBOLS, SYMBOLS, type Region, type VisualArchive } from './archive.js'
import type { Config } from './config.js'
import { imageBlock } from './content.js'

interface ViewSelection {
  label: string
  visual: string
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
          width: { type: 'number' as const },
          height: { type: 'number' as const },
        },
      },
    },
  },
}

export function registerTools(ctx: Context, archive: VisualArchive, config: Config): void {
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
            visual: { type: 'string', required: true, description: 'Stable id such as v12.' },
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
        const visual = archive.get(view.visual)
        if (!visual) throw new Error(`Unknown visual id: ${view.visual}`)
        const crop = await archive.crop(view.visual, view.region)
        const block = await imageBlock(ctx, crop.data, 'image/png')

        blocks.push(
          { type: 'text', text: `[${view.label}] ${input.question}` },
          block,
        )
        summary.push({
          label: view.label,
          visual: view.visual,
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
            visual: { type: 'string', required: true },
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
        measured.push({
          label: view.label,
          visual: view.visual,
          ...(await archive.readPixels(view.visual, view.region, view.rows, view.columns)),
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
}
