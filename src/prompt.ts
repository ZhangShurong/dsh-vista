import type { Context } from '@deepseek-ai/cordis'

export const VISTA_METHOD = `# Working with visuals

You can revisit any image you have already seen, not just the latest one.
Every image is labeled with a stable \`visual\` id.

When a detail matters, call \`inspect\` with a specific question and a short
label for each view. When a judgement depends on exact colors, call
\`read_pixels\`. Say what each view is meant to settle, then check whether it did.

Build a compact, revisable model of what you see and update it as new evidence
changes what is supported. Before acting, briefly state what you expect to see;
afterward, briefly state what changed. Do not request the whole image again
when a region will do.`

export function registerPrompt(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'dsh-vista',
    order: 500,
    text: VISTA_METHOD,
  })
}
