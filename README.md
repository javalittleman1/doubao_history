# 豆包侧栏按年月分组

一个给 **豆包网页版**（https://www.doubao.com/chat）用的 Tampermonkey 脚本：在左侧栏加一个「按年月分组」开关，点一下就把**全部历史对话**按 `年-月` 聚合展示，而不是像原生那样只有「最近」一条流水账。

- 在线安装（GreasyFork）：https://greasyfork.org/zh-CN/scripts/604029
- 从 GitHub 安装：https://raw.githubusercontent.com/javalittleman1/doubao_history/master/doubao-yearmonth-group.user.js
- GreasyFork 直链：https://update.greasyfork.org/scripts/604029/doubao-yearmonth-group.user.js

> 英文说明见 [README.en.md](README.en.md)

![效果预览](preview-yearmonth.png)

---

## 为什么需要它

豆包网页版侧栏的对话列表只能滚动浏览最近几十条，历史会话（尤其是几个月前的）基本翻不到。官方也没有提供时间维度的筛选。本脚本直接调用站点自己的会话列表接口，把**跨设备、跨项目**的全部会话拉下来（实测账号 761 条、23 个月份组），按月份重新组织成一个可折叠的列表。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 一键切换 | 侧栏顶部（「项目」上方）新增一行小按钮：`按年月分组` ↔ `返回最近列表` |
| 全量历史 | 走内部列表接口全量翻页，不受侧栏只加载几十条的限制 |
| 月份分组 | 按 `2024年1月`、`2024年2月`… 倒序分组，每组显示条数，可点击标题折叠 / 展开 |
| 标题补全 | 列表接口不返回标题，脚本再用批量接口分批补齐，渐进式填入 |
| 选中态 | 当前打开的会话在分组视图里高亮显示 |
| 滚动居中 | 点击（或整页刷新后）自动把选中的会话滚动到侧栏可见区域的**正中间** |
| 不刷新页面 | 点击条目走站点自身的前端路由（`history.pushState` + `popstate`），避免整页刷新、保持侧栏位置 |
| 状态记忆 | 切到分组视图后，跳转会话、刷新页面都会留在分组视图 |
| 缓存 | 列表缓存 10 分钟，右上角「刷新」可强制重读 |
| 深色模式 | 全部配色走 CSS 变量，自动跟随豆包深色主题 |
| 稳定性 | 单实例保护、防重复点击、React 重渲染后自动重新挂载 |

## 安装

1. 给浏览器安装 **Tampermonkey** 扩展（Chrome / Edge / Firefox 均可）。
2. 点扩展图标 →「添加新脚本」→ 清空编辑器里的模板。
3. 把 `doubao-yearmonth-group.user.js` 全文粘贴进去，`Ctrl+S` 保存。
4. 打开 https://www.doubao.com/chat/ ，刷新一次页面即可。

也可以直接把 `.user.js` 文件拖进浏览器窗口，Tampermonkey 会弹出安装确认页。

## 使用

- 侧栏在「更多」下面、「项目」上面多出一行 **按年月分组**，点一下进入分组视图；变成 **返回最近列表** 后再点一下切回原生列表。
- 点月份标题可以折叠 / 展开该月。
- 点会话条目直接进入该会话，当前会话会自动高亮并滚动到列表中间。
- 按住 `Ctrl`（macOS 为 `⌘`）点击条目会在新标签页打开，和原生行为一致。
- 右上角的 **刷新** 会忽略缓存重新读取整个列表。

## 配置

脚本开头有一段 `CFG`，按需修改：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pageSize` | `50` | 列表接口单页条数，服务端上限就是 50 |
| `maxPages` | `60` | 最多翻多少页（约 3000 条），会话特别多可以调大 |
| `nameChunk` | `50` | 每批补全标题的会话数 |
| `nameWorkers` | `4` | 并发补标题的请求数，网络差可以改小 |
| `cacheMs` | `600000` | 列表缓存时长（10 分钟） |
| `groupField` | `'create'` | 分组依据：`create` 按创建时间分月；改成 `'update'` 则按最后活动时间分月 |
| `storageKey` | `'dbym_enabled_v1'` | 开关状态的 localStorage 键名 |

## 工作原理

1. **取全量列表**：`POST /im/chain/recent_conv`，请求体 `cmd: 3200`，`direction: 2`（由旧到新翻页），`filter.device_filter: 0`（全设备，含桌面客户端产生的会话），`limit` 实际被服务端钳制为 50，靠 `next_conv_version` 翻页直到没有更多。
2. **补全标题**：列表接口默认不返回会话标题，于是用 `POST /im/conversation/batch_get`（`cmd: 1111`，`option.recent_message_count_per_conv: 0`）每 50 条一批、4 路并发把 `name` 取回来，边取边填。
3. **渲染**：把原生列表根节点 `[data-testid="chat_list_wrapper"]` 隐藏，在其后插入 `#dbym-panel`，按 `create_time`（秒级 Unix 时间戳）分月、倒序渲染。
4. **跳转**：拦截条目点击，用 `history.pushState` 切 URL 再派发 `popstate`，让站点自己的前端路由接管；3 秒内标题没变化则退回整页跳转兜底。
5. **定位**：用 `sessionStorage['dbym_center_id']` 记住要居中的会话，渲染完成或路由切换后计算目标条目与滚动容器的位置差，把 `scrollTop` 调整到让它居中（底部条目受滚动上限限制时尽量贴近）。

> 两个接口都必须带 `Content-Type: application/json; encoding=utf-8`（外加 `Agw-Js-Conv: str`），否则会返回「不支持编码类型」错误。

## 常见问题

**首次切换要等几秒？**
正常，全量列表 + 标题补全大约 5–15 秒（视会话数量），期间标题会短暂显示「读取中…」。

**显示「读取失败」？**
通常是登录态过期或接口变动。确认网页版能正常用之后，点右上角「刷新」重试；仍失败就说明接口结构改了，需要更新 `LIST_API` / `BATCH_API` 的字段。

**桌面客户端能用吗？**
不能。豆包桌面客户端是独立应用，跑不了浏览器扩展。

**为什么列表里能看到桌面客户端的对话？**
接口 `device_filter: 0` 取的是全设备会话，所以更完整。

**会话太多会不会很慢？**
默认最多 60 页（约 3000 条）。会话量特别大时把 `maxPages` 调小可以更快，但更早的月份会被截断。

## 兼容性

- 浏览器：Chrome / Edge / Firefox + Tampermonkey（`@grant none`，不依赖 GM API）。
- 站点：`https://www.doubao.com/*`，`@noframes`，`document-idle` 注入。
- 只对网页版生效，且依赖站点的内部接口与 DOM 结构，站点改版后可能需要同步调整。

## 更新日志

- **1.3.1**：源码改由 GitHub 托管，GreasyFork 通过源码同步自动跟进更新；脚本文件更名为 `doubao-yearmonth-group.user.js`。
- **1.3.0**：点击条目改为前端路由跳转（不再整页刷新）；新增选中态高亮与「滚动到列表中间」定位。
- **1.2.0**：修复开关位置随内容滚走、切换视图后滚动位置丢失；按钮加入防抖与单实例保护。
- **1.1.0**：改为全设备全量翻页 + 批量补标题，修复「只有 50 条」「标题全部未命名」。
- **1.0.0**：首个可用版本。

## 更新与发布

本仓库（GitHub `javalittleman1/doubao_history`）是脚本的唯一源码，GreasyFork 页面通过「源代码同步」跟随 `master` 分支自动发版。

发布一次新版本的流程：

1. 改代码，并把脚本头部的 `@version` 加一（例如 `1.3.1` → `1.3.2`），版本号不变时 GreasyFork 会判定「无更新」。
2. `git commit` + `git push`（推送到 origin，GitLab 会镜像到 GitHub `master`）。
3. GitHub 的 push 事件通过 webhook 通知 GreasyFork，GreasyFork 拉取 raw 文件并自动发布；万一 webhook 没触发，等自动同步（约 10 分钟）或在 GreasyFork「管理」页点「更新设置并立即同步」。

两种安装渠道的更新互不干扰：

- 从 GreasyFork 安装 → 走 GreasyFork 生成的 `@updateURL` 自动更新；
- 从 GitHub raw 安装 → Tampermonkey 按安装地址（raw 链接）检查更新。

## 免责声明

本项目为个人自用的非官方增强脚本，与豆包官方无关。脚本调用的是站点自身的内部接口，仅在你本人已登录的浏览器里读取你自己的会话数据。使用前请自行评估风险，接口变动导致的失效需自行维护。
