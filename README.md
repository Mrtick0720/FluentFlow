# FluentFlow

AI 驱动的双语阅读与英语学习 Chrome 扩展（Manifest V3）。原创实现，不复用任何现有扩展的源码、UI 素材或品牌。

**边浏览边学英语**：整页双语对照、点词查词、句子讲解、视频字幕学习、生词本/句子本、AI 阅读助手——默认全部数据本地存储，隐私优先。

## 功能

| 模块 | 说明 |
| --- | --- |
| 双语网页翻译 | 整页/段落/选中翻译；双语、仅译文、仅原文、左右对照四种模式；不破坏原排版，可完全还原 |
| 翻译引擎 | Google（免费，开箱即用）、DeepL、OpenAI、Azure、自定义 OpenAI 兼容端点（如本地 Ollama）；接口化，可扩展 |
| 查词 | 双击单词：音标、释义（中英）、词性、例句、近义词；AI 增强 CEFR 等级与搭配；真人音频/TTS 发音；一键存入生词本 |
| 句子学习 | 选中句子：翻译、语法讲解、难词解析、简化/进阶改写、收藏、复制导出 |
| 生词本 / 句子本 | 搜索、筛选、复习状态、标签、CSV/JSON 导出、导入、删除 |
| AI 对话助手 | 侧边栏与"当前页面"对话：总结、讲解、自然翻译、抽认卡；流式输出 |
| 视频字幕学习 | 适配器框架（YouTube/TED/BBC/通用 HTML5）：双语字幕、上一句/下一句/复读、A-B 循环、变速、字幕句收藏、AI 讲解 |
| 阅读统计 | 生词数、句子数、阅读时长、视频数、读完文章数——全部仅存本机 |
| 离线缓存 | 翻译/词典/AI 回答 TTL 缓存，可配置、可清空 |
| 隐私模式 | 默认不上传浏览历史/URL/标题/字幕，无遥测，无云同步；只有你主动翻译的文本会发送给所选服务方 |

字幕功能只读取页面已向用户公开的数据（原生 textTracks、可见字幕 DOM、公开文字稿），**绝不绕过 DRM、付费墙或登录限制**。

## 安装（开发版）

```bash
npm install
npm run build
```

然后打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。

## 使用

- 点击工具栏图标或按 `Alt+T` 翻译当前页；`Alt+M` 切换显示模式；`Alt+S` 翻译选中文本
- 双击任意英文单词查词；选中文本弹出快捷工具条
- 视频页右下角出现 `CC` 按钮 → 打开字幕学习面板
- 侧边栏（右下角 ☰ 或弹窗按钮）：AI 对话、生词本、句子本、统计
- 设置页：引擎与 API Key、AI 提供方、主题、字幕样式、缓存、备份/恢复

## 开发

```bash
npm run typecheck   # TypeScript 严格检查
npm test            # Vitest 单元测试（provider 解析、存储、缓存、VTT、设置迁移）
npm run test:e2e    # Playwright 端到端（加载 dist/ 到 Chromium，用本地 mock 引擎验证整页翻译）
npm run build       # 双构建：主构建（SW + React 页面）+ 内容脚本 IIFE
```

## 架构

```
Service Worker（所有网络 I/O 与存储收口于此，密钥不出后台）
  ├─ MessageRouter        类型化 RPC（shared/messages.ts）
  ├─ TranslationService   Provider 注册表 + 批量 + TTL 缓存
  ├─ DictionaryService    免费词典 API + AI 增强
  ├─ AIService            OpenAI 兼容 / Anthropic，SSE 流式
  └─ Repositories         IndexedDB（生词、句子、缓存、统计、对话）
Content Script（IIFE，Shadow DOM UI）
  ├─ PageTranslator       TreeWalker 收集 + IntersectionObserver 懒翻译 + 可逆插入
  ├─ 查词卡 / 句子卡 / 选择工具条 / 字幕面板（React in Shadow DOM）
  └─ SubtitleController   VideoAdapter 注册表（youtube/ted/bbc/generic）
Pages（React + Tailwind）
  ├─ Popup      快速开关、模式、引擎、站点规则、统计
  ├─ Options    全部设置、密钥（AES-GCM 静态加密 + RPC 掩码）、备份
  └─ Side Panel AI 对话 + 生词本 + 句子本 + 统计
```

设计文档见 [docs/superpowers/specs/2026-07-03-linguaflow-design.md](docs/superpowers/specs/2026-07-03-linguaflow-design.md)。

## License

MIT
