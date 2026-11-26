# 对话助手套件

一个安装项装好三件对话辅助能力：长期记忆、输入增强、回答质量门禁。

## 包含

- **长期记忆（Confluence）**：工作区总线（共享状态、便签、消息）、长期记忆候选与用户画像、输出风格卡，8 个工具与只读面板。
- **输入增强（pro-prompt）**：输入框语音输入与提示词优化，面板里可设默认模式。
- **回答质量门禁（Crisp，默认关闭）**：对最终回答做质量检查，可选用本机 `crisp` 二进制或 DSH 自己的模型评审。

## 用法

安装后：侧栏出现「Confluence」与「输入增强」面板；输入框左侧多出语音与优化按钮。Crisp 是关闭的，需要时在插件页打开对应行。

## 维护

源码全部在本仓库内（`confluence/`、`pro-prompt/`、`crisp/`、`client-sources/`），不依赖其他插件仓库。修改界面代码后运行 `node scripts/build-client.mjs`；修改 loader 行则编辑根 `cordis.patch.yml`，然后重载 bundle。

## 已知限制

- 三个界面合并在同一个浏览器模块里，任一界面报错会影响整块界面的加载。
- 本包必须保留包根 Loader 行（`assist-ui`，`name: dsh-assist-suite`）：DSH 只把包根行识别为客户端行，子路径行不会发布浏览器模块；删掉该行会导致所有界面消失。
- Crisp 依赖本机 `crisp` 可执行文件（`CRISP_BIN` 或 PATH），可用 `critic: harness` 改为复用 DSH 模型。
