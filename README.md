# MiniCore Web

MiniCore Web 0.1.1 是 MiniCore Host 的独立静态网页客户端。界面迁移自
minicore-tui 0.9.9 的网页，保留原有布局、样式、增量 Markdown、工具卡片和
桌面／手机交互，直接使用 Host 原生 WSS JSON-RPC。

工作分支为 `dev`。配套后端为 **minicore-host 0.12.5 / SPEC 4.11.4**；
CI 固定 Host 提交 `355d4b8bac4a3a634cd83a49fbf33fea7b67a262` 验证实际协议。
Web 的行为约定见 [SPEC.md](SPEC.md)。

## 运行

### 1. 配置并启动独立 Host

从 [minicore-host](https://github.com/zqcli/minicore-host/tree/dev) 构建或取得
0.12.5 可执行文件。可从本仓库的 `examples/host.web.json` 开始配置，
将它放置为所选配置目录下的 `host.json`：

- 替换模型 endpoint、provider_model 等提供方配置；模型密钥通过配置指定的环境变量提供。
- 将 `workspace_roots` 改为 Host 机器上实际存在的绝对目录。默认空数组不会开放任何目录。
- 设置 `network.listen`，并通过 `network.access_key_env` 指定 Host 访问密钥的环境变量。
- 配置与浏览器所用 Host 域名匹配、且受浏览器信任的 TLS 证书。

Host 每次启动读取 `--config-dir` 下的 `host.json`；配置目录与 `--data-root`
相互独立。`agents/` 和 `roles/` 可以不存在，Web 的首次动态 Agent 创建流程仍可使用。
如果已经声明了文件管理的 Agent，重新启动时必须保留对应声明。

从本项目之前配套的 Host 0.11.1 升级时，请使用新的、独立的数据根。
Host 0.12.5 不自动转换旧存储格式或旧目录布局；保留旧数据副本，不把旧目录当成
已经完成迁移的新格式。支持格式的数据根可在再次启动时复用身份和已保存的历史。

```sh
minicore-host \
  --data-root /absolute/path/to/minicore-web-data \
  --config-dir /absolute/path/to/minicore-config \
  --tls-cert /absolute/path/to/fullchain.pem \
  --tls-key /absolute/path/to/privkey.pem
```

Host 持有 Agent、Session、Turn、工具、审批、配置和持久化。
这里使用独立 Host 的 WSS 服务，升级 TUI 不会替换这个独立 Host。
当前 minicore-tui 的内嵌 Host 不开放网络监听，
不能把它当成上述 WSS 服务；两个 Host 进程也不能共用同一数据根目录。

### 2. 配置并启动 Web

需要 Node.js 22 或更高版本。修改 `web/config.json`：

```json
{
  "host_url": "wss://your-host.example:8443/",
  "templates": [],
  "initial_agent": {
    "name": "Assistant",
    "mode": "persistent",
    "config": {
      "role": {"name": "assistant", "description": "", "instructions": ""},
      "session_defaults": {
        "model": "provider/chat",
        "reasoning": "auto",
        "tools": [{"name": "read"}, {"name": "write"}, {"name": "edit"}, {"name": "apply_patch"}, {"name": "bash"}, {"name": "agent"}],
        "execution": {
          "approval": "ask",
          "prompt_timeout_ms": 30000,
          "model_timeout_ms": 600000,
          "policy_timeout_ms": 30000,
          "tool_timeout_ms": 1800000,
          "model_retry_attempts": 2,
          "model_retry_base_delay_ms": 100,
          "compaction": {"enabled": true, "trigger_percent": 95, "target_percent": 50}
        }
      }
    }
  }
}
```

`model`、reasoning 与工具选择必须与 Host 实际配置一致。此文件会公开给浏览器，
不能放 Host 访问密钥或模型密钥。

```sh
npm ci
npm start
```

打开 `http://127.0.0.1:8080/`，输入 Host 访问密钥。可用 `MINICORE_WEB_PORT`
修改本地静态服务端口。

Host 为空时，点击 **New session**，检查初始 Agent 设置、选择目录并点击 **Start**。
Web 会创建一个 Agent 及其默认 Session。启用本地工具需要工作目录，因此首次选择的目录
也会写入该 Agent 的默认配置。已有 Agent 的新 Session 可以另选目录；点击 Start 先建立
本地草稿，发送第一条消息时才调用 Host 创建 Session。

如果 Host 已有 Agent，可以删去 `initial_agent`；Web 会列出实际 Agent 和 Session。
该字段仅用于首次创建，不会每次连接都写入配置，也不会覆盖已有 Agent。

### 3. 部署静态文件

```sh
npm run check
npm test
npm run build
```

把 `dist/` 部署到 HTTPS 静态站点。配置在构建时从 `web/config.json` 原样复制；
也可以在部署时直接替换 `dist/config.json`。应用资源使用相对路径，支持静态站点子目录。
`npm start` 是本地预览服务，不是 Host 代理。

PWA 只缓存本站点作用域内的应用资源；不缓存配置、Host 访问密钥、WSS 消息或会话数据。
访问密钥保存在当前标签页的 `sessionStorage`，按 WSS 地址隔离；Sign out 会清除它。
离线应用外壳可以打开，但业务操作需要连接 Host。

## 已迁移的功能

| 功能 | 当前行为 |
| --- | --- |
| 会话导航 | Agent 选择、会话目录、搜索、固定、切换、重命名和关闭删除 |
| 新建会话 | 读取 Host 的可选目录根、分页浏览、显示隐藏目录、新建目录、选择工作区 |
| 对话 | 普通发送、运行中 steer、下一 Turn 的 follow-up、队列移除／编辑、取消当前 Turn |
| 输出 | 增量 Markdown、推理折叠、工具参数／结果、UTF-8 流式输出补读、历史向前加载 |
| 审批和交互 | 原生 allow_once／deny、文本／选项回答、未来 Turn 的审批策略设置 |
| 配置 | 当前 Session 的模型与 reasoning；变更在后续 Turn 生效 |
| 工作区 | `@` 文件路径引用、真实变更列表、原生差异分页、工具输出查看 |
| 上下文 | 展示 Host 已报告的上下文事实、历史计数、使用量及压缩状态；可手动压缩 |
| 本地交互 | 查找、复制、导出已加载内容、主题、字体、快捷键、手机抽屉、PWA |

### 0.1.1 的显示与操作改进

- Session 列表在标题旁固定显示原生 ID 的前 8 位。同名、重命名和窄屏截断时，
  可据此辨认会话；可访问名称和 **Copy session id** 保留完整 ID。
- 实时和历史失败都显示 Host 实际提供的原因。实时 Fault 有 HTTP 状态、提供方
  type/code、request ID 时，可展开查看；旧历史只有 reason 时不补造这些字段。
- **Settings → Last error** 可重新查看并复制本标签页最近一次错误，包含实际存在的
  原始 Host、Agent、Session 和操作身份。关闭提示后仍可查看；退出登录会清除记录。
- 手动压缩受理后，若后台完成失败，会提示原 Session 和完整原因，Context 也显示该原因。
  保留打开的 Context 面板后切换 Session，面板仍查看并操作原会话。
- 工具卡片预览最多显示最后 20 行、4096 个 UTF-16 单元，截断位置保留完整 Unicode
  字符；折叠错误和提示也限制预览长度。**Open**、**Copy** 和导出已加载内容保留完整正文。
  这些限制只作用于展示副本，不改变工具结果、传输或持久化历史。
- 浏览器继续使用 **Ctrl/Cmd+Enter** 发送或 steer，运行中 **Alt/Option+Enter** 排队
  follow-up，**Shift+Enter** 换行。输入法组合过程中不触发全局 Escape/停止快捷键。

### 语义说明

- 首条成功初始化的连接获得操作权；其他连接保持只读。操作连接断开后，原只读连接
  不会自动获得权限。界面允许只读连接阅读和编辑本地草稿，写入按钮不可用。
- 断线和观察恢复只重新读取事实，不重发业务请求。消息发送结果不明时保留本地副本，
  手动再次发送前明确提示可能重复；业务 ID 仅关联请求，不能当作幂等键。
- steer 和 follow-up 是 Host 的两个独立 FIFO 队列。停止当前 Turn 与移除已排队消息
  是独立动作。
- 当前 Turn 的配置已经绑定。“Future turn approval”只更新以后 Turn 使用的配置，
  不会把正在等待的审批自动放行。
- `@` 插入文本路径引用，首版没有文件上传。Share or export 导出当前已加载的对话内容，
  包含已加载的完整工具输出和失败原因；部分观察结果会明确标注，不会声称导出了尚未读取的历史。
- Host 没有报告的实时上下文 token 总量不显示成估算百分比。可以读取实际历史计数、
  最新响应使用量和自动压缩配置。
- 目录选择使用 `workspace.roots/list/mkdir`；已有会话的文件与变更查询沿用其原生工作区
  接口。可选目录根限定目录选择方法，不能代替工具执行的系统权限边界。

### 本地提示词模板

在 `config.json` 的 `templates` 中添加公开模板：

```json
[
  {"name": "review", "description": "Review a file", "hint": "[path]", "text": "Review $1 carefully. $@"}
]
```

输入 `/review "path with spaces.md" extra` 会展开模板后发送普通文本。
保留旧模板的 `$1`、`$@`、`$ARGUMENTS`、`${1:-default}` 和引号分组规则。
模板不是 shell 命令，不执行环境变量展开。

## 验证

```sh
npm run check
npm test
npm run build

# 使用已编译的真实 Host，测试自行建立临时数据、工作区和 TLS 证书。
MINICORE_HOST_BIN=/absolute/path/to/minicore-host npm run test:integration

# 浏览器测试另需 Playwright Chromium。
npx playwright install chromium
MINICORE_HOST_BIN=/absolute/path/to/minicore-host npm run test:browser
```

集成和浏览器测试启动实际 Host，使用实际 WSS、磁盘持久化、Git 工作区和本地工具。
只有模型 SSE 回答由明确的本地测试提供方控制；这些检查不是实时外部模型提供方验证。
测试服务显式提供 Chat Completions、Responses 分段推理和 HTTP 错误；不需要真实模型密钥。
浏览器测试保留桌面与手机截图，失败时也保存当前页面。CI 固定 Host 源码提交并执行
语法／导入检查、单元测试、构建、真实 WSS 集成和 Chromium 场景。
输入法测试使用浏览器合成 composition 标志验证事件传播，不代表已验证实体 macOS、Safari
或特定系统输入法；终端 Option-as-Meta 和 ESC 序列不属于本客户端。

## 代码组织

| 路径 | 职责 |
| --- | --- |
| `web/host.js` | 原生 WSS、JSON-RPC 请求、订阅与 UTF-8 输出缓冲 |
| `web/host-state.js` | 原生身份、状态版本、历史和实时输出的展示投影 |
| `web/host-app.js` | 捕获目标的应用动作、查询、Agent／Session 创建与观察恢复 |
| `web/net.js` | 登录、连接生命周期和既有 UI 的薄调用入口 |
| `web/core.js` | Markdown、提示词和 UI 纯函数 |
| `web/conversation.js` / `web/sessions.js` / `web/ui.js` | 原有界面与交互 |
| `tests/integration/` / `tests/browser/` | 真实 Host 应用与浏览器验证 |

来源与许可见 [PROVENANCE.md](PROVENANCE.md)。本仓库沿用 MIT / Apache-2.0 双许可证。
