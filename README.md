<p align="center">
  <img src="https://raw.githubusercontent.com/ZhangShurong/dsh-vista/main/assets/logo.png" width="112" alt="dsh-vista logo">
</p>

<h1 align="center">dsh-vista</h1>

<p align="center"><b>Visual memory and active inspection for DeepSeek Harness.</b></p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-vista"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-vista.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-vista"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-vista.svg"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dsh-vista.svg"></a>
  <a href="https://github.com/topics/dsh-plugin"><img alt="dsh-plugin" src="https://img.shields.io/badge/dsh-plugin-8A2BE2"></a>
  <a href="https://github.com/ZhangShurong/dsh-vista/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZhangShurong/dsh-vista/actions/workflows/ci.yml/badge.svg"></a>
</p>

---

# English

> Your agent sees an image once. dsh-vista makes it addressable forever.

DSH agents work with screenshots, charts, and rendered pages, but the image that
matters is often gone after the next tool call or compaction. dsh-vista keeps
every image it has seen in an addressable archive and gives the agent three
tools to go back to it:

- **`inspect`** — revisit any past image and crop any region, enlarged without
  smoothing;
- **`read_pixels`** — sample exact colors from a region as a compact symbol
  matrix;
- **`visuals`** — list the images the agent has already seen.

Every image that reaches the model is automatically tagged with a stable id:

```html
<visual id="v12" source="tool:read_image" size="1280x720"></visual>
```

The model can reference `v12` later even if the original image has fallen out of
the context window.

![dsh-vista in action](https://raw.githubusercontent.com/ZhangShurong/dsh-vista/main/assets/demo.png)

## Why

- **Compaction drops bytes, not meaning.** dsh-vista keeps the original bytes
  addressable after the context has moved on.
- **Re-screenshotting is expensive and lossy.** The screen has changed; the
  image you need is the one from three steps ago.
- **"Look at the whole image again" is not inspection.** A good visual agent
  asks a specific question about a specific region.
- **Text-only fallback.** `read_pixels` works even when the model route accepts
  text only.

## Install

```sh
dsh plugin --profile web add dsh-vista
```

Or pin a version:

```sh
dsh plugin --profile web add dsh-vista@0.1.3
```

Then verify:

```sh
dsh --profile web --dump-config | grep dsh-vista
dsh --profile web
```

From a GitHub checkout:

```sh
dsh plugin --profile web add github:ZhangShurong/dsh-vista#v0.1.3
```

## Tools

| Tool | What it does | Output |
| --- | --- | --- |
| `inspect` | Select an archived `visual` and an optional region; crops from the original and enlarges with nearest-neighbour. | Image blocks |
| `read_pixels` | Divide a region into equal rows and columns; sample each centre pixel. | Palette + symbol rows |
| `visuals` | List recent visuals with id, source, size, and timestamp. | JSON |

Example `inspect`:

```json
{
  "question": "Did the button move after the click?",
  "views": [
    {
      "label": "button before",
      "visual": "v11",
      "region": { "x": 1180, "y": 40, "width": 100, "height": 60 }
    }
  ]
}
```

Example `read_pixels` result:

```json
{
  "palette": { "0": "#FF0000", "1": "#0000FF" },
  "views": [
    { "label": "quadrant", "visual": "v1", "rows": 2, "columns": 2, "samples": ["01", "11"] }
  ]
}
```

`read_pixels` only measures. It does not align, transform, or interpret pixels.

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

The archive is content-addressed and append-only (`index.jsonl` plus files under
`archiveDir`). DSH's attachment service still owns the image that reaches the
model; dsh-vista keeps a second copy so visual ids survive compaction and image
offload.

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

## Verified against DSH 0.2.1-rc.2

Tested end to end with `deepseek-flash`:

1. `read_image` returned an image; dsh-vista archived it and appended
   `<visual id="v1" source="tool:read_image" size="16x16">`.
2. `visuals` listed `v1`.
3. `inspect` cropped and enlarged the archived image and returned a
   model-visible 1024×1024 PNG.
4. `read_pixels` returned the expected `01 / 11` color samples.
5. The model correctly described the red/blue quadrants.

The attachment bridge in `src/content.ts` uses:

```ts
ctx.attachments.saveImage({ data, mediaType, name })
ctx.attachments.imageHostPath(ref)
```

Both are confirmed in the installed `@deepseek-ai/dsh-attachment`.

## What this deliberately does not do

- No environment adapters (ARC-AGI-3, GameWorld, browser automation).
- No `play` / `act` action tools.
- No one-action-per-turn policy, budgets, or evaluation harness.
- No Python sidecar.

Those belong in follow-up plugins. This one answers a narrower question: does
addressable visual memory plus active inspection improve a DSH agent's visual
work?

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
npm pack --dry-run
```

The package is an ESM bundle. `lib/` is generated; `assets/` contains the logo
and README images.

## Releasing

Publishing runs in GitHub Actions, not from a laptop.

**Tag-driven (recommended):**

```sh
npm version patch          # or minor / major
git push --follow-tags
```

**Manual button:**

Actions → **Publish** → *Run workflow* → choose `patch`, `minor`, or `major`.
The workflow bumps the version, commits, tags, and publishes.

The workflow uses npm **Trusted Publishing** (OIDC) and publishes with
provenance. One-time setup:

1. Open https://www.npmjs.com/package/dsh-vista/access
2. Add a **Trusted Publisher** → GitHub Actions:
   - Owner: `ZhangShurong`
   - Repository: `dsh-vista`
   - Workflow filename: `publish.yml`
3. No `NPM_TOKEN` secret is needed.

If you prefer a token instead, add an `NPM_TOKEN` repository secret and set
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and `npm pack --dry-run`
on every push and pull request.

## License

MIT

---

# 中文

> 你的 agent 只见过一张图一次，dsh-vista 让它永久可寻址。

DSH agent 经常要处理截图、图表和渲染后的页面，但真正重要的那张图，往往在下一次工具调用或上下文压缩之后就消失了。dsh-vista 会把 agent 见过的每一张图保存进一个可寻址的归档，并提供三个工具让它随时回去查看：

- **`inspect`** —— 重新查看任意历史图像并裁剪任意区域，以无平滑插值的方式放大；
- **`read_pixels`** —— 把某个区域采样成紧凑的符号矩阵，读取精确颜色；
- **`visuals`** —— 列出 agent 已经见过的图像。

每一张送到模型面前的图像都会自动带上一个稳定的 id：

```html
<visual id="v12" source="tool:read_image" size="1280x720"></visual>
```

即使原图已经掉出上下文窗口，模型之后仍然可以引用 `v12`。

![dsh-vista 实际效果](https://raw.githubusercontent.com/ZhangShurong/dsh-vista/main/assets/demo.png)

## 为什么需要它

- **上下文压缩丢掉的是字节，不是语义。** 上下文过去之后，dsh-vista 仍然让原始字节保持可寻址。
- **重新截图既昂贵又有损。** 屏幕已经变了；你需要的往往正是三步之前那张图。
- **"再把整张图看一遍"不叫检视。** 好的视觉 agent 会针对某个具体区域提出具体问题。
- **纯文本兜底。** 即使模型路由只接受文本，`read_pixels` 依然可用。

## 安装

```sh
dsh plugin --profile web add dsh-vista
```

或锁定版本：

```sh
dsh plugin --profile web add dsh-vista@0.1.3
```

然后验证：

```sh
dsh --profile web --dump-config | grep dsh-vista
dsh --profile web
```

从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:ZhangShurong/dsh-vista#v0.1.3
```

## 工具

| 工具 | 作用 | 输出 |
| --- | --- | --- |
| `inspect` | 选择一个已归档的 `visual` 和可选区域；从原图裁剪，并用最近邻插值放大。 | 图像块 |
| `read_pixels` | 把区域划分成等分的行和列，采样每个格子中心像素。 | 调色板 + 符号行 |
| `visuals` | 列出最近的 visual，包含 id、来源、尺寸和时间戳。 | JSON |

`inspect` 示例：

```json
{
  "question": "点击之后按钮移动了吗？",
  "views": [
    {
      "label": "点击前的按钮",
      "visual": "v11",
      "region": { "x": 1180, "y": 40, "width": 100, "height": 60 }
    }
  ]
}
```

`read_pixels` 返回示例：

```json
{
  "palette": { "0": "#FF0000", "1": "#0000FF" },
  "views": [
    { "label": "四个象限", "visual": "v1", "rows": 2, "columns": 2, "samples": ["01", "11"] }
  ]
}
```

`read_pixels` 只做测量，不对像素做对齐、变换或解释。

## 工作原理

```
工具结果 / 附件
        │
        ▼
tools/post-execute ──► 归档字节、分配 vN、在前面插入 <visual id="vN">
        │
        ▼
     模型看到：<visual id="v12" ...></visual>  [image]
        │
        ├── inspect(v12, region)      ──► 裁剪并放大的图像
        ├── read_pixels(v12, region)  ──► 调色板 + 符号行
        └── visuals()                 ──► 历史图像索引
```

归档采用内容寻址、仅追加的方式（`index.jsonl` 加上 `archiveDir` 下的文件）。送到模型面前的图像仍然由 DSH 的 attachment 服务管理；dsh-vista 额外保留一份副本，让 visual id 在上下文压缩和图像卸载之后依然存活。

## 配置

默认值位于 `src/config.ts`。可以在 bundle 配置行或 profile 补丁中覆盖：

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

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `archiveDir` | `$DSH_HOME/dsh-vista/archive` | 字节存储与 `index.jsonl` 所在目录。 |
| `displaySize` | `1024` | 检视裁剪图的最长边。 |
| `maxInspectViews` | `8` | 单次 `inspect` 调用允许的视图数。 |
| `maxPixelViews` | `16` | 单次 `read_pixels` 调用允许的视图数。 |
| `maxPixelSamples` | `4096` | 单次 `read_pixels` 调用的采样总数。 |
| `annotate` | `true` | 在每张已归档图像前插入 `<visual id="...">`。 |
| `retentionDays` | `7` | 删除超过该天数的归档；`0` 表示永久保留。 |

## 已针对 DSH 0.2.1-rc.2 验证

使用 `deepseek-flash` 做了端到端测试：

1. `read_image` 返回一张图像；dsh-vista 将其归档并追加 `<visual id="v1" source="tool:read_image" size="16x16">`。
2. `visuals` 列出了 `v1`。
3. `inspect` 裁剪并放大了归档图像，返回一张模型可见的 1024×1024 PNG。
4. `read_pixels` 返回了预期的 `01 / 11` 颜色采样。
5. 模型正确描述了红蓝象限。

`src/content.ts` 中的附件桥接使用：

```ts
ctx.attachments.saveImage({ data, mediaType, name })
ctx.attachments.imageHostPath(ref)
```

两者均已在安装的 `@deepseek-ai/dsh-attachment` 中确认可用。

## 刻意不做的事

- 不做环境适配器（ARC-AGI-3、GameWorld、浏览器自动化）。
- 不提供 `play` / `act` 动作工具。
- 不做每回合单动作策略、预算或评测框架。
- 不使用 Python sidecar。

这些都属于后续插件。本插件只回答一个范围更窄的问题：可寻址的视觉记忆加上主动检视，能否提升 DSH agent 的视觉工作表现？

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
npm pack --dry-run
```

本包是 ESM bundle。`lib/` 为构建产物；`assets/` 存放 logo 与 README 图片。

## 发布

发布通过 GitHub Actions 完成，不在本地笔记本上执行。

**Tag 驱动（推荐）：**

```sh
npm version patch          # 或 minor / major
git push --follow-tags
```

**手动触发：**

Actions → **Publish** → *Run workflow* → 选择 `patch`、`minor` 或 `major`。工作流会自动更新版本号、提交、打 tag 并发布。

工作流使用 npm **Trusted Publishing**（OIDC），并带 provenance 发布。一次性配置：

1. 打开 https://www.npmjs.com/package/dsh-vista/access
2. 添加一个 **Trusted Publisher** → GitHub Actions：
   - Owner：`ZhangShurong`
   - Repository：`dsh-vista`
   - Workflow filename：`publish.yml`
3. 不需要配置 `NPM_TOKEN` secret。

如果你更想用 token，可以添加 `NPM_TOKEN` 仓库 secret，并在发布步骤中设置 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。

CI（`.github/workflows/ci.yml`）会在每次 push 和 pull request 时运行 typecheck、build 和 `npm pack --dry-run`。

## 许可证

MIT
