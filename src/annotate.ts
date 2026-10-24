import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { VisualArchive } from './archive.js'
import type { Config } from './config.js'
import { isVisualLabel, readImageBytes, visualLabel } from './content.js'

/**
 * The hidden half of the design: every image the model sees gets a stable id.
 *
 * `tools/post-execute` can replace content. We call `next()` first, then
 * annotate whatever content will actually be delivered. If the pipeline
 * blocks the call, we leave the decision untouched.
 */
export function registerAnnotator(ctx: Context, archive: VisualArchive, config: Config): void {
  if (!config.annotate) return

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision

    // A value-only acceptance cannot also carry content in this union.
    if ('value' in decision) return decision

    const content = decision.content ?? result.content
    if (!content?.some((block) => block.type === 'image')) return decision

    const annotated: ContentBlock[] = []
    for (const block of content) {
      if (block.type !== 'image') {
        annotated.push(block)
        continue
      }

      // Do not stack labels if another plugin (or a retry) already annotated.
      const previous = annotated.at(-1)
      if (previous && isVisualLabel(previous)) {
        annotated.push(block)
        continue
      }

      try {
        const toolName = String(exec.name ?? 'tool')
        const data = await readImageBytes(ctx, block.attachment)
        const visual = await archive.ingest(data, {
          source: `tool:${toolName}`,
          label: `result of ${toolName}`,
          callId: String(exec.callId ?? ''),
        })
        annotated.push({ type: 'text', text: visualLabel(visual) })
      } catch {
        // Archiving must never break the tool result itself.
      }
      annotated.push(block)
    }

    return {
      kind: 'accept',
      content: annotated,
      ...(decision.additionalContexts
        ? { additionalContexts: decision.additionalContexts }
        : {}),
    }
  })
}
