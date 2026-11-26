# dsh-assist-suite · 对话助手套件

一个 bundle（一个安装项、一个仓库），插件列表里只有 **1 行**：融合插件主体 `assist-core`。

## 结构

| 目录 / 文件 | 作用 |
|---|---|
| `index.js` | **融合插件**：把 `confluence/`、`pro-prompt/`、`crisp/` 三个成员挂到同一个插件主体，并承载 `client.js` |
| `confluence/` | 工作区总线、长期记忆、用户画像与风格卡（8 个工具 + 只读面板路由） |
| `pro-prompt/` | 输入框语音与提示词优化（面板路由、默认模式持久化） |
| `crisp/` | 回答质量门禁（默认不加载） |
| `client.js` | 合并后的浏览器模块：Confluence 面板 + 输入框按钮 |
| `client-sources/` | 合并前的界面源码 |
| `cordis.patch.yml` | 唯一的那一行，含融合配置的三个 section |

## 融合配置（`config`）

```yaml
confluence: {}     # Confluence 的完整配置；缺省用成员内部默认值
proPrompt: {}      # pro-prompt 的完整配置；缺省用成员内部默认值
crisp:
  enabled: false   # 设为 true 才加载质量门禁
```

## 安装与维护

- 安装：`plugin_manager install_bundle target=D:/05_Code/dsh-assist-suite`。
- 改宿主代码：直接改对应成员目录，重启 DSH 或重载 bundle。
- 改界面：改 `client-sources/<name>.js`，运行 `node scripts/build-client.mjs`，再重载 bundle。
- 打开 Crisp：把配置里的 `crisp.enabled` 改为 `true`（需要本机 `crisp` 可执行文件或 `critic: harness`），并按需重建界面把它的状态页加回。
- 整体停用：`set_bundle` target=`dsh-assist-suite`，enabled=`false`。

## 注意

- 只有一行插件，所以三个功能不能分别整行停用；Crisp 用配置开关，Confluence 与 pro-prompt 随整组启用。
- 一个 bundle 只有一个浏览器模块（模块 id = 包名）。
- Confluence 的存储路径与数据格式不变，历史数据继续可用。
