[**在 Mac App Store 下载 Agent Pulse**](https://apps.apple.com/app/id6815483068)

# Agent Pulse

在 Stream Deck Neo 上查看 Codex 和 Claude 的任务状态、完成情况和观察到的工作时长，
并在 Mac 上浏览活动日历。

[English](README.md)

App Store 提供官方安装版和更新，可用性取决于发布状态及所在商店地区。购买官方版
可以支持持续开发。本仓库只提供源码，不发布预编译安装包。

## 使用教程

### 1. 连接 Neo

从 App Store 安装 Agent Pulse，将 Stream Deck **Neo** 通过 USB 连接到 Mac。
启用 Agent Pulse 的设备控制前，先退出 Elgato Stream Deck 应用。
安装 Codex 或 Claude，并运行一次任务，让它们生成本地日志。

### 2. 启用 Agent

打开 Agent Pulse 的 **Settings → Agent Integrations**，启用你使用的 Agent。
商店版需要点击各 Agent 旁的 **Choose log folder** 并选择对应目录：

| Agent | 需要选择的目录 |
|---|---|
| Codex | `~/.codex` |
| Claude | `~/.claude/projects` |
| Claude Desktop 模型数据（可选） | `~/Library/Application Support/Claude/claude-code-sessions` |

在文件夹选择窗口按 **Command + Shift + G**，即可输入隐藏目录路径。
可选的 Claude Desktop 权限用于补充模型和推理信息。默认自行构建的独立版自动发现
本地 Agent 日志目录。

### 3. 开启设备控制

在 **Stream Deck & Startup** 中选中 Neo，打开 **Control Neo**，然后点击
**Save settings**。通过 **Setup Status** 检查目录权限或设备占用状态。
**Launch at login** 默认关闭，如需登录启动，启用后保存即可。

### 4. 查看任务与时长

在 Codex 或 Claude 中发起任务并处理审批，通过 Neo 的 Agent 入口查看任务页。
触摸灯亮起表示该方向还有可到达的页面内容。商店版只观察任务，执行和审批仍在
原 Agent 应用中完成。

Mac 上的 **Working Time** 可以选择 Agent，再按日、周、月、年浏览。
关闭设置窗口后仍会继续监控；要停止应用，请从菜单栏选择 **Quit**。

### 常见问题

- **Neo 被占用：**退出 Elgato Stream Deck 应用、重新连接 Neo，并检查设备选择和
  **Control Neo** 开关。
- **没有显示任务：**确认 Agent 已启用、已经产生本地日志；商店版还需要正确的目录
  授权。运行一次新任务后再观察。
- **撤销权限：**点击 Agent 旁的 **Revoke access**，或在 Maintenance 中选择
  **Remove integrations**。这些操作不会删除原始 Agent 对话。

## 功能与要求

- 本地监控 Codex 和 Claude，以不同颜色区分 Agent。
- 在 Neo 上翻阅任务页、查看活动和完成状态。
- 在 Agent 提供信息时显示实际模型和推理强度。
- 查看工作时长日历，配置监控、设备接管、菜单栏和登录启动。

需要 Apple Silicon Mac、macOS 13 或以上版本，以及 USB 连接的 Stream Deck
**Neo**。目前不支持其他 Stream Deck 型号、Intel Mac、Windows、iOS 或 iPadOS。
Codex／Claude 的账户、服务权限和硬件需要另行准备。

工作时长不是 Token 用量、费用或模型计算时间。进度百分比表示可获取的结构化
计划步骤完成情况。

## 自行构建

安装 Node.js 24 或以上版本（须包含 Node-API 头文件）、npm，以及 Xcode
Command Line Tools（`xcode-select --install`），然后在仓库根目录运行：

```sh
npm ci
npm run build
npm test
```

构建完成后运行开发版：

```sh
npm run app:dev
```

生成自己使用的独立应用包和 DMG：

```sh
npm run prepare:app-deps
npm run package:mac
```

应用包位于 `packages/app/out/Agent Pulse-darwin-arm64/`，DMG 位于
`packages/app/out/make/`。普通本地构建不需要维护者的签名凭据或 Apple Developer
会员资格，也没有 Developer ID 签名或公证。macOS 可能要求明确允许打开本地
构建的应用；请保持系统安全保护开启。

部分集成检查需要本地 IPC 权限；实际设备检查需要连接 Neo。构建和测试不会自动
安装应用，也不能代替实机验证。启动开发版可能使用已有设置并接管连接的 Neo。

## 与商店版的差异

默认源码构建使用独立配置；商店版使用单独的 MAS／App Sandbox 配置。

| 能力 | 默认源码构建 | App Store 版 |
|---|---|---|
| Neo 任务显示和工作时长历史 | 支持 | 支持 |
| 日志访问 | 本地集成设置 | 用户选择目录，可撤销权限 |
| Managed Codex、Claude hooks | 可用 | 不包含 |
| 项目验证、跨应用键盘操作 | 按权限可用 | 不包含 |
| 执行任务和审批 | 取决于集成方式 | 在原 Agent 应用中进行 |
| 更新 | 自行重新构建 | 通过商店 |

MAS 打包需要自己的 Apple 签名身份、描述文件和数字构建号。维护者的凭据不属于
源码构建内容。许可证不允许将自行构建的版本上架商店或向外部用户分发。

## 依赖与第三方许可

Node.js、npm 和 Xcode Command Line Tools 用于构建；从商店安装应用不需要它们。
主要软件依赖如下：

| 依赖 | 用途 | 许可摘要 |
|---|---|---|
| Electron | macOS 应用运行时 | MIT；内含 Chromium 的其他许可声明 |
| Electron Forge | 本地应用及 DMG 打包 | MIT |
| TypeScript / Vite | 类型检查与打包 | Apache-2.0 / MIT |
| `@elgato-stream-deck/node` | Stream Deck USB 通信 | MIT |
| Sharp / libvips | 图像渲染与处理 | Apache-2.0 / LGPL-3.0-or-later |
| `lucide-static` | UI 图标 | ISC；另见附带声明 |
| `ws` / Acorn | 本地 WebSocket IPC／解析 | MIT |
| Lobe Icons SVG 素材 | Agent 品牌图标 | MIT；商标权单独保留 |

确切版本和传递依赖记录在[根锁文件](package-lock.json)与[应用锁文件](packages/app/package-lock.json)。
构建命令和直接依赖见[根清单](package.json)及[应用清单](packages/app/package.json)。
请保留[第三方许可声明](THIRD_PARTY_NOTICES.md)与[素材署名](ASSET_NOTICES.md)，
本项目的源码公开许可证不会替代第三方许可。安装应用本地依赖后，可以运行
`npm run notices` 重新生成随应用分发的依赖声明。

## 隐私与授权

应用在本地运行，没有开发者运营的账户系统、遥测、广告或云同步，不向开发者上传
提示词、对话、源码或审批内容。Agent 服务适用各自条款。数据位置、权限和删除
方式见[隐私说明](PRIVACY.md)。

项目采用 [Agent Pulse Source-Available License 1.0](LICENSE)，属于源码公开，
不是 OSI 定义的开源许可证。主要边界如下：

- 允许阅读、修改、自行编译及个人或内部工作使用，包括有偿工作。
- 允许免费分享源码 fork 和补丁，须保留许可证与声明，并标明修改。
- 允许在同一法律实体内部按许可证分享构建产物。
- 不允许向外部用户分发编译包，即使免费；不允许转售、换名销售、重新上架，
  或向外部客户提供包含该软件的产品或托管服务。
- 第三方组件适用各自的许可证，详见[第三方声明](THIRD_PARTY_NOTICES.md)。

不提供第三方转售、白标或商业再分发授权。本节仅为摘要，以英文许可证为准。
源码构建的问题和建议请提交到本仓库的 GitHub Issues。源码公开项目不提供邮件客服，
也不承诺回复时限。App Store 官方版的购买用户可使用商店页面的支持入口。
提交代码或素材前请阅读[贡献说明](CONTRIBUTING.md)。请不要在公开 Issue 中附带
私人对话、凭据、个人联系方式或未经脱敏的诊断文件。

Agent Pulse 由 Doonutsaur Games LLC 开发，与 OpenAI、Anthropic、Elgato
没有隶属或背书关系。第三方名称和商标归各自权利人所有。
