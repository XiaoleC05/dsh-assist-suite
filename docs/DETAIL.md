# 对话助手

一个侧栏入口装好三件对话辅助能力。

## 侧栏入口页

打开侧栏「对话助手」可以看到：

- **长期记忆（Confluence）**：工作区总线、长期记忆候选、用户画像与风格卡；已迁移为页内「高级记忆」标签。
- **输入增强（pro-prompt）**：语音输入与提示词优化；已迁移为页内「输入增强」标签。
- **质量门禁（Crisp）**：默认关闭，不对回答做评审；需要时把配置里的 `crisp.enabled` 设为 true。

## 包含

- 8 个 Confluence 工具（board / context / send / inbox / profile / memory / style / recall）与只读面板。
- 输入框左侧语音与优化按钮。
- Crisp 质量门禁（默认不加载）。

## 维护

入口页在 `client-sources/hub-assist.js`；改界面后运行 `node scripts/build-client.mjs`；改宿主代码后重启 DSH 或重载 bundle。

## 已知限制

- 只有一行插件，功能不能单独整行停用；Crisp 用配置开关。
- 界面合并在同一个浏览器模块里，任一界面报错会影响整块界面加载。
- 打开 Crisp 需要额外提供评审凭据或改用 `critic: harness`。
