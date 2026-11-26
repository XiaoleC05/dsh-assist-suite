# 备选方案建议（当前只启用首选）

当前实现（2026-11-19 起）：全部通过 **SiliconFlow 中转站**：ASR 为 **`Qwen/Qwen3-ASR-1.7B`**，润色/优化为 **`deepseek-ai/DeepSeek-V4.1-Flash`**，共用 profile 级 `apiKey`。以下是可替代方案、理由与影响范围；当前只启用这一组，不启用其他备选。

## 判断标准

1. 不新建密钥、不新增 Key 配置界面；
2. 不新增持久化存储，不保存音频/提示词历史；
3. 中文口语识别质量与标点/ITN 稳定；
4. 与浏览器录音 → 同源路由 → 识别 → 润色的链路兼容；
5. 成本、延迟、隐私可接受；
6. 改动范围可控。

## 方案清单

### A. 本地 FunASR / Paraformer（推荐作为“隐私优先”备选）

- 项目：<https://github.com/modelscope/FunASR>，21,059 stars（2026-11-18），MIT。
- 理由：中文识别强、可本地部署、无按次费用、录音不出本机；支持 VAD、标点、流式。
- 影响：需要 Python 运行时和模型文件（通常数百 MB 到 GB），会**新增存储占用**并需要常驻进程；本插件要增加本地服务管理/健康检查，Host 代码与安装步骤都会变。
- 结论：与“不占用额外存储空间”的硬约束冲突，当前不采用；若用户愿意放宽存储约束，这是最值得做的替代。

### B. faster-whisper / Whisper（本地多语种）

- 项目：<https://github.com/SYSTRAN/faster-whisper>，26,828 stars；<https://github.com/openai/whisper>，113,055 stars；均 MIT。
- 理由：生态成熟、多语种、可离线；faster-whisper 推理更快。
- 影响：同样需要下载模型、占用磁盘/内存；中文标点与 ITN 不如专用中文 ASR 稳定；需要本地服务或 Node 绑定。
- 结论：不优于当前方案；仅在需要多语种/离线时考虑。

### C. SenseVoiceSmall（本地中文/多语种）

- 项目：<https://github.com/QwenAudio/SenseVoice>，9,774 stars，MIT。
- 理由：中文/粤语/英日韩、速度快，适合本地实时。
- 影响：模型文件与运行时；需要额外服务；与当前“零额外存储”冲突。
- 结论：本地备选，非当前最优。

### D. 其他云厂商（Azure Speech / Google STT / 讯飞）

- 理由：可能有更强的中文方言/实时能力。
- 限制：需要新建 Key/账号/计费体系，数据出境或跨厂商；违反“复用现有 SiliconFlow 密钥”的约束。
- 结论：不采用；除非用户明确要求更换供应商。

### E. 润色/优化换成更大的 chat 模型（如 `DeepSeek-V4-Pro` / `Qwen3.8-27B`）

- 理由：更强的指令遵循和长文组织，可能提升结构优化质量。
- 影响：单价与延迟更高；输出风格可能变化；需要重新跑提示词回归。结构优化实测约 12–22s，更大模型通常更慢。
- 结论：当前 `DeepSeek-V4.1-Flash` 在质量/延迟间更均衡；没有证据表明必须升级。

### F. 提示词优化改用 DSH 内置模型

- 理由：不需要 SiliconFlow Key 也能优化；与当前 agent 使用的模型一致。
- 限制：与当前 SiliconFlow chat 链路的输出风格/保真度不同；语音仍需要 SiliconFlow Key。
- 结论：可作为“Key 不可用时的降级”，但会偏离当前单一 Provider；本次未实现。

### G. 流式 ASR / 实时字幕

- 理由：说话时即时出字，体验更好。
- 限制：需要 WebSocket/流式服务与新的音频分片协议；当前批处理 ASR 链路要重写；复杂度和失败面明显增加。
- 结论：不在本次范围。

## 推荐

**当前方案**：SiliconFlow `Qwen/Qwen3-ASR-1.7B` + `deepseek-ai/DeepSeek-V4.1-Flash`，共用一把 SiliconFlow 密钥；两段链路均已用真实接口验证。

如果用户愿意放宽“零额外存储”，首选本地 **FunASR/Paraformer**；如果主要痛点是结构优化质量，可对 **DeepSeek-V4.1-Flash → DeepSeek-V4-Pro / Qwen3.8-27B** 做小范围 A/B，而不是直接替换。任何替换都需要用户确认后再改 `lib/config.js`、`lib/chat.js`、提示词回归测试和 UI 文案。

## 图片模型目录的接入推荐（2026-11-19）

用户提供的模型目录包含以下相关模型（其余为 TTS/会议分离，不适用）：

| 模型 | 定位 | 适配度 |
| --- | --- | --- |
| **Qwen/Qwen3-ASR-1.7B** | Qwen3-ASR 系列，52 种语言/方言，1.7B | **首选** |
| **FunAudioLLM/SenseVoiceSmall** | 轻量多语种 ASR/LID/SER/AED，约 0.5B 以下 | **轻量备选** |
| XingChenAGI/XingChenASR-V3.2-Ultra | 60 方言、工业级、语义转写 | 方言/工业场景备选 |
| XingChenAGI/XingChenASR-V3.2 | 中英+30 方言，2024 版 | 次选（Ultra 更新） |
| XingChenAGI/XingChenGSR-V1.0 | 生成式 ASR + 语义理解 | 不建议（可能改写原话） |
| XingChenAGI/XingChenASR-Diarize-V3.0 | 会议说话人分离 | 不需要 |
| fnlp/MOSS-TTSD-v0.5 | TTS（文本转语音对话） | 任务不匹配 |
| FunAudioLLM/CosyVoice2-0.5B | TTS/语音合成 | 任务不匹配 |

**推荐：Qwen/Qwen3-ASR-1.7B。**

- 与 Qwen3-ASR 系列同源，中文标点/识别风格适合语音润色；当前插件已选定该模型。
- 52 种语言/方言，1.7B 规模适中，单卡 GPU 可部署；准确率通常优于 SenseVoiceSmall，尤其是嘈杂、长句、专名。
- 若 MaaS 提供 OpenAI 兼容音频接口，适配量较小；若没有，需要按实际推理接口加适配层。

**轻量备选：SenseVoiceSmall。** 约 0.5B 以下，CPU 可跑、延迟低，中文/粤语/英日韩，MIT；适合本地/边缘。缺点是标点/ITN 往往需要 FunASR 的标点模型补，准确率不如 Qwen3-ASR-1.7B。

**方言/工业场景：XingChenASR-V3.2-Ultra。** 60 方言、工业级，适合方言重的客服/会议；专有模型，需确认授权、部署和费用。普通开发者语音输入不需要。

**不建议：** XingChenGSR（生成式 ASR 可能改写原话）、Diarize（会议分离）、MOSS-TTSD/CosyVoice2（TTS）。

**如果不想自建/换模型：** 当前已选定 SiliconFlow `Qwen/Qwen3-ASR-1.7B`；图片里的其他模型仍是备选，接入前需要有效密钥和对应端点的音频 API。
