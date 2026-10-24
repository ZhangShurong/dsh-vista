import { readFile } from 'node:fs/promises'

import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

import type { StoredVisual } from './archive.js'

/**
 * DSH keeps image bytes behind an attachment reference. The host may expose a
 * read-only path for same-process consumers; otherwise the attachment service
 * must be used to materialize the request variant.
 *
 * TODO(spike): confirm the exact `imageHostPath` / read API on the installed
 * @deepseek-ai/dsh-attachment version.
 */
export async function readImageBytes(ctx: any, attachment: any): Promise<Buffer> {
  const hostPath = ctx.attachments?.imageHostPath?.(attachment)
  if (typeof hostPath === 'string') return readFile(hostPath)

  const stream = ctx.attachments?.readFileStream?.(attachment)
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  throw new Error('Cannot materialize an image attachment in this DSH build.')
}

/**
 * Register bytes with DSH's attachment service and return a model-facing image
 * block. Tools must not hand raw base64 to the model directly: ImageBlock
 * carries an attachment reference so the provider adapter can choose the
 * request dimensions and encoding.
 *
 * TODO(spike): confirm the `saveFile` signature and media-type option name.
 */
export async function imageBlock(ctx: any, data: Buffer, mimeType: string): Promise<ImageBlock> {
  const attachment = await ctx.attachments.saveFile(data, { mediaType: mimeType })
  return { type: 'image', attachment } as ImageBlock
}

export function visualLabel(visual: StoredVisual): string {
  return `<visual id="${visual.id}" source="${escapeAttribute(visual.source)}" size="${visual.width}x${visual.height}"></visual>`
}

export function isVisualLabel(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.startsWith('<visual id="')
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}
