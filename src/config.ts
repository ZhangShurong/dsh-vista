import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Where archived visual bytes and the visual index live. */
  archiveDir: string
  /** Longest edge used when rendering an inspected crop. */
  displaySize: number
  /** Maximum views accepted by one inspect call. */
  maxInspectViews: number
  /** Maximum views accepted by one read_pixels call. */
  maxPixelViews: number
  /** Maximum total samples accepted by one read_pixels call. */
  maxPixelSamples: number
  /** Insert a stable <visual id="..."> label before every archived image. */
  annotate: boolean
  /** Delete archived visuals older than this many days. 0 disables cleanup. */
  retentionDays: number
}

export const Config: Schema<Config> = Schema.object({
  archiveDir: Schema.string().default(
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-vista', 'archive'),
  ),
  displaySize: Schema.number().default(1024),
  maxInspectViews: Schema.number().default(8),
  maxPixelViews: Schema.number().default(16),
  maxPixelSamples: Schema.number().default(4096),
  annotate: Schema.boolean().default(true),
  retentionDays: Schema.number().default(7),
})
