# dsh-assist-suite · 对话助手

一个 bundle（一个安装项、一个仓库）。侧栏只有一个助手入口「对话助手」；插件列表只有 **1 行**（`assist-core`）。

## 界面

- 侧栏「对话助手」→ 入口页：页内标签「概览」「高级记忆」「输入增强」。两个旧页面已完全迁移为页内标签，不跳转。
- 设置 → 通用 → **「重启应用」**：修改需要重启才生效的配置后，点一下会关闭当前窗口并在约 3 秒后自动重新打开（Windows 桌面端没有其他重启入口）。
- 高级记忆页、输入增强页、输入框语音/优化按钮仍然在内；旧插件的侧栏图标已收进入口页。

## 结构

| 目录 / 文件 | 作用 |
|---|---|
| `index.js` | **融合插件**：组合 `confluence/`、`pro-prompt/`、`crisp/`（默认不加载） |
| `confluence/` | 工作区总线、长期记忆、用户画像与风格卡（8 个工具 + 只读面板路由） |
| `pro-prompt/` | 输入框语音与提示词优化 |
| `crisp/` | 回答质量门禁（默认关闭） |
| `client-sources/hub-assist.js` | 对话助手入口页（唯一侧栏图标 + 功能概览） |
| `client.js` | 合并后的浏览器模块（入口页 + 记忆面板 + 输入框按钮） |
| `cordis.patch.yml` | 唯一那一行，含融合配置的 section |

## 融合配置（`config`）

```yaml
confluence: {}     # Confluence 配置；缺省用成员默认值
proPrompt: {}      # pro-prompt 配置；缺省用成员默认值
crisp:
  enabled: false   # 设为 true 才加载质量门禁
```

## 维护

- 安装：`plugin_manager install_bundle target=D:/05_Code/dsh-assist-suite`。
- 改界面：改 `client-sources/<name>.js`，运行 `node scripts/build-client.mjs`，再重载 bundle。
- 打开 Crisp：把配置里的 `crisp.enabled` 改为 `true`（需要 `crisp` 可执行文件或 `critic: harness`）。
- 整体停用：`set_bundle` target=`dsh-assist-suite`，enabled=`false`。

## 注意

- 只有一行插件，三个功能不能分别整行停用；Crisp 用配置开关。
- 旧插件的侧栏图标通过 `globalThis.__DSH_SUITE_INTEGRATED_UI` 关闭，主区页面保留，便于入口页跳转。
- Confluence 的存储路径与数据格式不变，历史数据继续可用。
