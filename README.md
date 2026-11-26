# dsh-assist-suite · 对话助手套件

一个 DSH bundle（一个安装项，一个仓库）。三个对话辅助插件现在是这个包里的目录与一个合并后的浏览器模块，不再依赖任何外部插件包。

## 组成

| 目录 / 文件 | 来源 | 提供 |
|---|---|---|
| `confluence/` | 原 Confluence 仓库 | 工作区总线、长期记忆、用户画像与风格卡（8 个工具 + 侧栏面板） |
| `pro-prompt/` | 原 pro-prompt | 输入框语音输入与提示词优化（输入框按钮 + 面板） |
| `crisp/` | 原 Crisp 集成目录 | 回答质量门禁（默认关闭） |
| `client-sources/` | 三个成员各自的 client.js | 合并前的界面源码 |
| `client.js` | 生成 | 三个界面合成的唯一浏览器模块 |
| `index.js` | — | 包根行的宿主半（空实现）：DSH 只把**包根 Loader 行**当作客户端行，这一行负责发布上面的 `client.js` |
| `cordis.patch.yml` | 手写 | 四行 loader：包根行 `assist-ui` + 三行成员（Crisp 行带 `disabled: true`） |

## 安装

```
plugin_manager install_bundle target=D:/05_Code/dsh-assist-suite
```

## 维护

- 改宿主代码：直接改对应目录，重启 DSH 或在插件页把 `dsh-assist-suite` 关再开。
- 改界面：改 `client-sources/<name>.js`，运行 `node scripts/build-client.mjs` 生成 `client.js`，再重载 bundle。
- 启用 Crisp：`set_plugin` 打开 `crisp-quality-gate` 行；建议同时把评审方式改为 `critic: harness`（不需要额外 API key）。
- 只停用一项：`set_plugin` 关闭对应行；整体停用：`set_bundle` enabled=`false`。

## 注意

- 一个 bundle 只有一个客户端模块（模块 id = 包名），三个界面必须合成 `client.js`；任一界面报错都会影响这个模块的加载。
- Confluence 的存储路径与行 id 保持不变，历史数据继续可用。
- 旧仓库（Confluence、pro-prompt、Crisp 等）已不再被 DSH 引用，仅作为历史保留。
