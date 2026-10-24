# dsh-vista

Addressable visual memory and active inspection for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a small capability layer, not a second harness. It gives a DSH agent three
tools and one working method:

- `inspect` — revisit any image it has already seen, at any region;
- `read_pixels` — sample exact colors from a region as a symbol matrix;
- `visuals` — list the images it has already seen;
- plus a short system-prompt section describing when and how to use them.

The hidden fourth piece is annotation: every image that reaches the model is
tagged with a stable `visual` id, so historical images remain addressable even
after they fall out of the model context.

## How it works

```
tool result / attachment
        │
        ▼
tools/post-execute ──► archive bytes, assign vN, prepend <visual id="vN">
        │
        ▼
     model sees: <visual id="v12" ...></visual>  [image]
        │
        ├── inspect(v12, region)      ──► cropped + enlarged image
        ├── read_pixels(v12, region)  ──► palette + symbol rows
        └── visuals()                 ──► index of previous images
```

The archive keeps a second copy of the bytes on disk. DSH's attachment service
still owns the image that reaches the model; the archive exists so visual ids
survive context compaction and image offload.

## Requirements

- A DSH build with the `tools`, `systemPrompt`, and `attachments` services.
- A model route that accepts images (`deepseek-flash` does). With a text-only
  model, `inspect` cannot help; `read_pixels` still can.

## Build

```sh
pnpm install
pnpm build
```

## Install into a profile

```sh
dsh plugin --profile web add /path/to/dsh-vista
dsh --profile web --dump-config   # expect a dsh-vista layer
dsh --profile web
```

For development:

```sh
dsh plugin --profile web add ./
dsh web
```

## Configuration

Defaults live in `src/config.ts`. Override them in the bundle row or the
profile patch:

```yaml
- id: dsh-vista
  config:
    archiveDir: /home/me/.dsh/dsh-vista/archive
    displaySize: 1024
    maxInspectViews: 8
    maxPixelViews: 16
    maxPixelSamples: 4096
    annotate: true
    retentionDays: 7
```

| Field | Default | Meaning |
| --- | --- | --- |
| `archiveDir` | `$DSH_HOME/dsh-vista/archive` | Byte store and `index.jsonl`. |
| `displaySize` | `1024` | Longest edge of an inspected crop. |
| `maxInspectViews` | `8` | Views per `inspect` call. |
| `maxPixelViews` | `16` | Views per `read_pixels` call. |
| `maxPixelSamples` | `4096` | Total samples per `read_pixels` call. |
| `annotate` | `true` | Insert `<visual id="...">` before every archived image. |
| `retentionDays` | `7` | Delete older archived visuals; `0` keeps forever. |

## Tools

### `inspect`

```json
{
  "question": "Did the button change after the click?",
  "views": [
    {
      "label": "button before",
      "visual": "v11",
      "region": { "x": 880, "y": 40, "width": 120, "height": 60 }
    }
  ]
}
```

Crops from the archived original and enlarges with nearest-neighbour. Omitting
`region` inspects the whole image.

### `read_pixels`

```json
{
  "question": "Which color is the target cell?",
  "views": [
    {
      "label": "target cell",
      "visual": "v12",
      "region": { "x": 32, "y": 32, "width": 16, "height": 16 },
      "rows": 4,
      "columns": 4
    }
  ]
}
```

Returns a palette and one symbol string per sampled row. It measures pixels; it
does not interpret them.

### `visuals`

```json
{ "limit": 20 }
```

Returns the recent `visual` ids with source, size, label, and timestamp.

## System-prompt section

`src/prompt.ts` adds the method: revisit before re-requesting, ask a specific
question per view, use exact measurements when a judgement needs them, and keep
a compact, revisable model of what is visible.

## What this deliberately does not do

- No environment adapters (ARC-AGI-3, GameWorld, browser automation).
- No `play` / `act` action tools.
- No one-action-per-turn policy, budgets, or evaluation harness.
- No Python sidecar.

Those belong in follow-up plugins. This one only answers whether addressable
visual memory plus active inspection improves a DSH agent's visual work.

## Two things to verify against the installed DSH build

1. **Image content blocks.** `ImageBlock` carries an `attachment` reference, not
   bytes. `src/content.ts` uses `ctx.attachments.saveFile(bytes, { mediaType })`;
   confirm the exact signature and option name in your `@deepseek-ai/dsh-attachment`
   version.
2. **Reading attachment bytes.** `src/content.ts` prefers
   `ctx.attachments.imageHostPath(ref)` and falls back to `readFileStream`.
   Confirm the available host-side read API in your build.

Both are isolated in `src/content.ts`; the rest of the plugin does not depend on
the answer.

## Development

```sh
pnpm typecheck
```

The archive format is append-only `index.jsonl` plus content-addressed files.
Deleting the archive directory is safe; ids restart from `v1`.
