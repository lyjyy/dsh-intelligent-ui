# dsh-intelligent-ui

[![license](https://img.shields.io/github/license/lyjyy/dsh-intelligent-ui?style=flat-square)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话内可交互界面插件：模型在对话里**渲染一块面板**（选项卡片、表单、表格、向导、图表、上传、diff、时间线……），然后**阻塞等待**你作答，你的点击/输入作为这次工具调用的结果回传给模型。

和 ChatGPT 的 Intelligent UI 同一思路：不是让模型在文本里描述「你可以选 A 或 B」，而是直接把可点的控件放进对话。

```
模型调用 interactive_ui({ title, elements: [...] })
        ↓
对话里出现一块可交互面板 → 你点击 / 填写 / 提交
        ↓
工具返回 { action, button, values, cancelled } → 模型继续
```

## 安装

```bash
dsh plugin add github:lyjyy/dsh-intelligent-ui
```

装完重启 DSH。之后你不需要关心任何参数——直接说需求，模型的运行时会自己拿到完整契约。

## 能做什么

26 种控件：文本、Markdown、链接、快捷按钮、下拉、单选卡片、多选、开关、滑杆、数字、单行/多行输入、日期、时间、目录选择、文件上传、表单、表格、多步向导、图表（柱/折线/饼/环）、行级 diff、时间线、复选框树、进度条、标签页。

四个工具：

| 工具 | 用途 |
| --- | --- |
| `interactive_ui` | 自己拼控件面板 |
| `interactive_ui_template` | 现成模板：`approval` / `picker` / `plan` / `survey` / `form` |
| `interactive_ui_gallery` | 画一遍全部控件（只读，选型时用） |
| `interactive_ui_history` | 读回你做过的选择 |

几个值得知道的行为：

- **每块作答面板底部都有一个自由备注框**，答案落在 `values.user_note`。选项不合意时不必勉强挑「最不坏的那个」，直接说真正想要什么。
- **填到一半不会丢**：切换页面或刷新回来，面板原样还在（存在浏览器 `localStorage`，7 天过期）。注意它救不了「重启 DSH」——那个换端口后是另一个存储桶。
- **必填项在面板这一侧校验**：空着点提交不会发出去，缺哪几项会列出来。

## 数据落在哪

| 内容 | 位置 |
| --- | --- |
| 上传的文件 | `<DSH_HOME>/cache/dsh-intelligent-ui/uploads/<callId>/` |
| 作答历史（JSONL） | `<DSH_HOME>/plugin-data/dsh-intelligent-ui/history.jsonl` |
| 填到一半的草稿 | 浏览器 `localStorage`，**不在磁盘上** |

`DSH_HOME` 默认 `~/.dsh`。插件只监听 loopback，非本机请求返回 403。

## 已知限制

- 面板值不跨 DSH 重启保留（浏览器存储按端口隔离，而端口每次重启都变）。
- 工具没有声明超时：面板会一直等你，直到作答或你按停止。
- 只跟随 DSH 的主题 token，不提供独立配色设置。

## 开发

```bash
node test/selftest.mjs         # host 46 项
node test/client.selftest.mjs  # client 67 项
node test/screenshot.mjs       # 截图基线比对（需本机 Chrome）
node test/preview.mjs          # 生成 docs/preview.html 离线预览页
```

**改 `lib/index.js`（host）必须重启 DSH**——ESM 启动时 import 一次就被缓存。**改 `lib/client.js`（浏览器）不用重启**：页面每 4 秒比对 bundle 代次会自己重载，或点输入框右侧的 `⟳`。

截图基线图 `docs/preview-baseline/*.png` 只有跑截图测试时需要，普通使用者可以忽略。

## 版本

当前 **0.12.0**。历史版本见 [Releases](https://github.com/lyjyy/dsh-intelligent-ui/releases)。

## 许可证

[MIT](LICENSE)

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
