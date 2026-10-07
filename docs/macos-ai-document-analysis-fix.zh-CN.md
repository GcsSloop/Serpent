# Serpent 0.2.10-macos.6

2026-10-08，修复文档预览的 AI 分析链路。

## 已复现根因

AI 单素材菜单对所有可用素材显示“AI 分析”，实际 Worker 的 enqueueAiAnalysisJobs 却只允许 IMAGE_EXTENSIONS、VIDEO_EXTENSIONS 和 MODEL_EXTENSIONS。DOCUMENT_EXTENSIONS（PDF、PDF 兼容 Illustrator、HTML/HTM）有可视预览，却被入队时跳过。批量入口在旧 macos.4 中将零任务映射为 AI_ANALYSIS_FAILED；macos.5 修复了错误反馈，但尚未补上文档分析功能。即使只放宽入队，asset.analyze 的准备阶段仍然会把文档 MIME 当作不支持，无法发给模型。

使用安装在 /Applications 的 macos.4 和隔离配置，在新建资源库导入 PDF，确认连接测试成功、右键 AI 分析菜单可点击，点击后立即显示“AI 服务未能完成资产分析”，数据库没有任何 AI 作业。合成 PDF 和真实 iCloud PDF 副本均可复现。

此路径已证明程序缺陷可产生用户报告的完整症状，但用户尚未提供最初报错文件名，无法排除其它格式或不同路径。不要将这个复现结论表述为所有 AI 失败都来自文档。

## 修复

- 文档进入既有视觉分析队列，无需数据库迁移。
- 文档使用 Serpent 拥有的栅格预览，按原有最长边预算编码；不尝试将 PDF、Illustrator 或 HTML 原文件直接作为图片发送。
- 预览未生成时按原有文档渲染流程准备：PDF/AI 使用隔离 PDF 解码线程，HTML/HTM 使用受控离屏渲染。解码失败保持失败反馈，不制造成功结果。
- 模型提示明确区分文档，PDF/AI 只提供首页，HTML/HTM 只提供可见窗口；不声称已分析整个文档。
- 各厂商适配器传递 mediaType，使文档、视频、模型的提示分支实际生效。
- 保留 macos.5 的具体入队错误与跳过反馈。

## 验证

120 项相关单元测试、91 项 AI Worker 测试通过；类型与相关代码检查通过。
真实 iCloud PDF 副本：macos.4 连接成功、分析立即失败且没有任务；macos.6 创建作业、成功写入 AI 标签与其它结果，界面显示“AI 分析完成”。
打包应用验收通过：red.png → green.png → red.png → PDF → 同一 PDF 再次分析 → Illustrator → HTML，共七次实际右键分析。每次检查描述、标签、评分和模型版本持久化，并在分析中并行发起连接检测。两次无密钥冷启动也通过。
合成 PDF 与 .ai 最初内容相同，触发了正常的重复导入确认；调整测试夹具颜色使文件内容不同后重新执行，不把该测试准备失败当作分析故障。

最终打包应用 4 项验收通过，1 项 Windows 专用测试跳过；包含实际导入、FTS5 搜索、连续分析及冷启动。应用签名、DMG 完整性、ZIP 内版本及 ASAR 与验收应用一致性、SHA-256 均通过。最终产物验收与安装包完整性记录见 out/diagnostics/ai-root-cause/。真实资源库只做只读检查；复现与验证使用临时配置和素材副本，原资源库及 AI 设置未更改。未安装新应用或替换 /Applications/Serpent.app。

## 交付

Apple Silicon arm64，本地临时签名，无 Apple 公证。使用已验证本地媒体组件包构建。

- out/make/Serpent-0.2.10-macos.6-arm64.dmg
- out/make/zip/darwin/arm64/Serpent-darwin-arm64-0.2.10-macos.6.zip
- out/make/SHA256SUMS-macos.6-arm64.txt

功能提交：cf1280fd。

