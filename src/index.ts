import type { Context } from '@deepseek-ai/cordis'

import { VisualArchive } from './archive.js'
import { registerAnnotator } from './annotate.js'
import { Config, type Config as ConfigType } from './config.js'
import { registerPrompt } from './prompt.js'
import { registerTools } from './tools.js'

export { Config }
export type { ConfigType as ConfigShape }

export const name = 'dsh-vista'

/** `attachments` is required because every rendered crop becomes an ImageBlock. */
export const inject = ['tools', 'systemPrompt', 'attachments']

export async function apply(ctx: Context, config: ConfigType): Promise<void> {
  const archive = new VisualArchive(config)
  await archive.open()

  registerPrompt(ctx)
  registerAnnotator(ctx, archive, config)
  registerTools(ctx, archive, config)

  ctx.effect(() => () => archive.close())
}
