# M3.1 认证能力调研（只读，未实现）

返回：[主计划](../m3.1-plan.md) · [调研索引](../m3.1-research.md)。本文保留事实、候选方案与限制；实施范围以主计划的明确取舍为准。
调研日期：2026-10-10。基线：本仓库安装的 `@earendil-works/pi-coding-agent@1.1.0` 和配套 `pi-ai@1.1.0` 发布包；上游 `v1.1.0` 对应不可变提交 `abe508e1b89912adde45528136c3221eb69acdd7`。本文以固定提交链接为依据，不以滚动 main 声称当前能力。未读取日常 auth.json、未登录、未调用模型、未修改产品代码。2026-10-10 已按主计划第 14 节的审阅修订同步；其中“进程内应用”一项当时是对发布 JS 的静态阅读；其后 G3 原型已运行并选定进程内应用，同时证实以 `!` 开头的密钥会被执行、必须先转义为字面值，G5 证实自定义供应商的密钥可存入官方凭据文件，见[门槛验证记录](../m3.1-gates.md)。下文与该记录不一致之处以该记录和主计划为准。

证据提取：从发布包 sourcemap 的 `sourcesContent` 提取源码；其中 model-runtime、auth-storage、auth/types、kimi-coding OAuth、openai-codex OAuth、openai-chatgpt OAuth 六文件与固定上游提交原文 SHA-256 比较完全一致，见 `source-verification.json`。余下文件直接取自相同发布包 sourcemap。下文“事实”来自静态源码核对；所有 pi-pane 新设计均是建议，需要未来 spike 和测试，不能当作已经验证可用。

## 1. 核心结论

1. 网页 login/logout 可调用公开 SDK；缺少 RPC login 命令不是 pi 本身不可实现。`ModelRuntime` 在 coding-agent 公共入口导出，公开 login、logout、listCredentials、checkAuth、getProviderAuthStatus、refresh。[公共导出](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/index.ts#L229-L235)、[认证方法](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts#L819-L842)
2. 认证应由前台宿主管理；对话与会话写入继续交给唯一 RPC child。宿主独立创建 ModelRuntime 即可，**不要为了登录创建第二个 AgentSession**，否则默认 ResourceLoader 会 reload 项目资源／扩展。ModelRuntime.create 本身不创建会话、不加载扩展；允许 `modelsPath:null`、`refreshOnCreate:false` 和明确 `authPath`。[ModelRuntime.create](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts#L216-L263)、[SDK 默认资源加载](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/sdk.ts#L191-L207)
3. **RPC child 的认证应用需要明确机制。**`get_available_models` 返回缓存快照；没有标准认证刷新 RPC。文件的外部变化可被 AuthStorage 后续读取发现，但不足以保证缓存的模型列表即时变化。应用方式有两个候选，由 S2 对比。优先**进程内原生会话替换**：对当前会话发 `switch_session`（未落盘空会话用 `new_session`）；静态阅读显示 CLI 每次原生替换都新建 ModelRuntime 并重读 auth.json（发布 JS `dist/core/agent-session-services.js:56–61`，`dist/main.js` 的 createRuntime 未传入旧实例），它保留扩展取消语义，不换锁、不关 stdin。回退为空闲检查后**受控重启 child**，恢复同一会话、cwd、选择及启动选项，与 project-switch 生命周期共用代码。不能承诺“写 auth.json 然后发 get_available_models 就刷新好了”。[RPC get_available_models](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L488-L491)、[版本感知读取](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/auth-storage.ts#L401-L447)
4. 原生凭据作用域是 **agentDir 全局、每 provider 一个 credential**，不是每项目／每浏览器账号。切项目不会隔离模型账户；不应展示邮箱、组织、套餐额度等上游没有稳定提供的字段。[CredentialInfo / CredentialStore](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/types.ts#L34-L91)
5. “已经保存”不等于“远端有效、额度充足”。`checkAuth` 对 OAuth 主要判断 credential 类型和对应 provider 的 OAuth 能力；普通 API key helper 只是保存用户输入，不发验证请求。首次模型请求仍可能失败。UI 必须区分已配置、已验证、待应用、验证失败。[checkProviderAuth](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/models.ts#L651-L674)、[API key helper](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/helpers.ts#L9-L30)

## 2. 公开交互协议能覆盖的 UI

`AuthType` 只有 api_key 和 oauth；device/manual/callback 是 OAuth 流程形态，不是新的 credential 类型。Adapter 应按 provider 返回的结构渲染，不硬编码某家登录网页。[完整类型](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/types.ts#L117-L254)

| 上游交互 | 网页控件与行为 | 约束 |
|---|---|---|
| prompt: secret | 密码字段；提交后立即清空前端值 | 不进草稿恢复、localStorage、URL、聊天记录、通用命令 receipt 或调试日志 |
| prompt: text | 单行输入 | 字段可能是 account/gateway/project ID 等非密钥配置；仍按敏感表单处理 |
| prompt: select | 按 id/label/description 渲染选择 | 回答返回 option id；未知 id 拒绝 |
| prompt: manual_code | 一次性授权码或完整回调 URL 输入 | 含授权码的 URL 也是秘密；验证和 token exchange 仍交上游实现 |
| notify: auth_url | 明确的“打开授权页”链接及说明 | 不在认证页嵌入第三方 iframe、不把带 state 的 URL 当普通日志；限制安全协议 |
| notify: device_code | 用户码、验证页、有效期与等待状态 | 移动端不要求访问宿主 localhost；轮询和 backoff 由 provider 实现 |
| notify: info/progress | 一般说明与进度 | 错误／消息只经脱敏边界，不能透传任意 error object |
| signal / prompt.signal | 取消整个操作／撤销当前步骤 | callback 与手动输入可能竞速；已被取消的旧 prompt 不能继续提交 |

## 3. provider 首批范围建议

这是实现优先级建议，不代表本轮已登录验证。发布支持矩阵要标出“确定性适配测试”和“真实账户端到端试用”两种证据。

| 分组 | 固定版本能力依据 | M3.1 建议承诺 |
|---|---|---|
| 普通 API key：OpenAI、Anthropic、Google Gemini、Qwen Token Plan Individual | provider 声明 apiKey，通常使用 envApiKeyAuth；Anthropic 有专门 resolve | P1 第一批：网页录入、替换、删除存储凭据及状态；至少一个经授权的真实 API key provider 完成模型试用。不要因输入被保存就显示“验证成功”。[OpenAI](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/openai.ts)、[Anthropic](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/anthropic.ts)、[Google](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/google.ts)、[Qwen](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/qwen-token-plan-individual.ts) |
| 设备码 OAuth（以 pi 内置 provider `kimi-coding` 的实现为核对样本；它是 pi 自带的模型 provider，与 Kimi Code 网页参照无关） | device_code + polling；refresh 可取消；返回 OAuth credential | P1 第一批 OAuth 类型：同机与远程手机都走 device flow，适配按类型通用；真实试用选维护者授权的任一内置设备码 provider，试过哪家才给哪家打已验证标记。[实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/kimi-coding.ts#L266-L295) |
| OpenAI Codex OAuth | 用户选择 browser callback 或 device code；device flow可能服务端未启用；callback 为 localhost:1455并支持手动回填 | P1 条件纳入：先完成合成 callback/manual/device 三类 adapter 测试，再对可用账户实际试用；不能保证服务端启用所有路径。[选择](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/openai-codex.ts#L413-L430)、[callback](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/openai-codex.ts#L359-L399) |
| Anthropic OAuth | browser callback/manual 或 copy-code headless 两种选择 | 条件纳入，远程使用 copy-code/manual；保留 provider 报错，不承诺所有账户可用。[选择](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/anthropic.ts#L280-L299) |
| OpenAI provider 的 ChatGPT OAuth | 与 openai-codex 是不同实现；需要稳定安装 device ID；固定回调端口被占会直接失败；有手动回填 | 单独能力条目，不能混为 Codex OAuth 或已覆盖；完成端口占用／取消／重复尝试验证后再开放。[实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/openai-chatgpt.ts#L233-L296) |
| GitHub Copilot OAuth | 提示 GitHub 域名然后 device code；后续有模型启用步骤 | 后续扩充；enterprise域名／证书／账号许可需要独立用例，不用公共 GitHub 成功概括 enterprise。[实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/oauth/github-copilot.ts#L434-L477) |
| Bedrock / Vertex 等 ambient credential | 不只是粘贴 key；AWS profile/role、ADC、service account 文件及区域等 | 首期可显示配置来源与使用说明；不在浏览器执行 aws/gcloud 安装或 IAM 管理，不承诺删除存储就使环境凭据失效。[Bedrock](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/amazon-bedrock.ts)、[Vertex](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/google-vertex.ts) |
| 自定义／扩展 provider | `models.json` 的兼容端点是数据配置；登录 handler 则可能来自扩展的可执行注册 | `models.json` 兼容端点按主计划 5.4 以结构化表单交付（新增、编辑、删除）。扩展注册的登录不额外加载到宿主，显示“当前需在终端认证”；已存凭据继续供 child使用 |

### 与 Kimi 模型服务商设置的边界

根任务另已实测 Kimi Code 2.1.1 的“新增模型服务商”表单包含 API 协议、API Key、Base URL、模型 ID／上下文等。这是**自定义 provider/model 配置编辑**，不是调用内置 provider.login 就能覆盖的登录能力。

按维护者 2026-10-10 明确的对齐标准（两边都有的同类功能保持一致、各用各的语义），它与 pi 的 `models.json` 兼容端点配置是同类功能，算缺口，**本期交付**，不再只读。设计见主计划 5.4，验收为主计划的 M31-PROV-01–08，技术门槛为 G5。与本附录相关的约束：

- 它与内置 provider 的登录是两个入口、两个结果，不能以内置 provider 认证完成声称供应商配置已对齐。
- 表单只作结构化编辑，不是任意 JSON 编辑器；表单未覆盖的字段原样保留、只读显示。
- 密钥输入只作字面值，沿用第 5 节对 `!command`、`$ENV` 的处理；已有命令型或环境型配置不执行、不回显。密钥优先存入官方 AuthStorage，是否可行由 G5 证实，否则以字面值写入 `models.json` 并明示保存位置。
- 保存后的应用与凭据应用共用同一方式和空闲门槛。
- 仍不包含：provider 扩展的编写与安装、models.dev 目录或注册表导入、llama.cpp 路由管理。

## 4. 存储、同步、失效语义

### 已证实的存储行为

- `AuthStorage` 用 proper-lockfile 串行 read-modify-write，跨进程避免覆盖；异步锁 stale 30 秒；新建目录0700、文件0600，但不强制覆盖管理员已有ACL/mode。login 先运行交互，拿到 credential 后才进入修改；并非让用户等授权时长持有 auth.json 锁。[文件后端](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/auth-storage.ts#L24-L202)、[Models.login](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/models.ts#L762-L817)
- 写入不是“稍后 flush”；公开 AuthStorage 没有 flush 方法，modify/delete 返回后完成该文件写路径。设置管理器的 flush 不应套用到认证。
- ModelRuntime 还按 provider 串行 login/logout/runtime key 修改，完成后刷新本 runtime 的模型／认证快照。这不更新另一个进程的 runtime。[队列及同步](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts#L573-L635)
- CredentialSynchronizationError 表示**凭据已变更但本地状态同步失败**，且 error.credential 可含完整 credential。必须投影为有限错误码和安全说明；禁止 JSON.stringify(error)、对象展开、保存 cause 或 credential。UI 要显示“凭据已保存，运行时尚未同步”，不可把它误判为完全未生效后反复登录。[定义](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts#L134-L153)
- logout 删除该 provider 的存储 credential，不是 provider 远端全局撤销授权接口；环境变量、models.json/API key命令或启动运行时覆盖仍可能提供认证。`RuntimeCredentials` 的覆盖只在所在 runtime 内移除，宿主 logout 不会直接抹掉 child 的 CLI override。[runtime overlay](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/runtime-credentials.ts#L12-L50)、[认证来源](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts#L639-L651)

### 建议的应用事务

1. 认证交互不占用会话：开始时只取得账户操作互斥，排斥另一次账号修改和其他全局配置写入；对话、会话和项目操作照常进行。设备码授权可能持续十几分钟，不能让它阻塞全部对话。空闲、无排队输入、无扩展对话框的门槛只加在“应用”这一步。
2. 将 provider、authType、ownerLeaseId、operationId、递增 stepId、取消信号放在宿主内存；公开事件仅投影当前安全状态。持久凭据只存当前有效 agentDir/auth.json；不能让前端提交任意 authPath。
3. 调用 **正在运行的 pi 安装版本** 的 ModelRuntime，不另引入不匹配版本；只支持已列入矩阵的 provider。为纯内置认证使用 modelsPath:null、refreshOnCreate:false并显式控制网络；非内置配置需独立范围评审。不要创建 AgentSession/ResourceLoader、不重复加载 pi-pane 扩展。
4. 只让发起浏览器回答 secret/manual_code；每个 step 幂等提交一次，后到旧 step 返回 expired。其他页面只看到“账号配置进行中”，可以取消该操作，但看不到也不能回答步骤。不复用 M3 将扩展对话框广播给所有客户端的通道。
5. login/logout 结果分成 cancelled-before-write、failed-before-write、committed-needs-apply、applied。提交后即使取消也先查安全状态，不能声称没发生修改。
6. 保存后若运行时空闲则立即应用，否则保持“已保存待应用”，由用户在空闲后触发，不在回复结束时自动替换运行时。应用优先用进程内原生会话替换，扩展否决时保持待应用；回退路径才受控停旧 child，等待退出及锁状态确定，再按同一 cwd/session恢复新 child。保留前台宿主 Hub；新 epoch拒绝旧写请求；应用失败进入可重试“已保存但未应用”，不悄悄覆盖凭据回滚。应用只作用于本宿主的运行时，同一 agentDir 下其他宿主或 TUI 不会被刷新；宿主重建/refresh安全元数据，新快照才成为有效模型列表。
7. UI 提供“清除保存的凭据”而非承诺“完全退出所有认证”。若环境或启动参数仍生效，显示来源和下一步，不把环境变量或 key值返回浏览器。全局影响在确认动作上直接说明：“应用于此 pi agent 目录下的所有项目”。
8. 操作的存续不绑定 WebSocket 是否在线：手机用户必须离开页面去授权，后台标签页的连接会被系统挂起，按断线计时取消会让移动端 device flow 无法完成。取消条件为：任一已认证页面显式取消、provider 流程自身到期（如设备码有效期）、操作绝对上限（建议15分钟，待 spike校准）、发起 lease失效或网页访问令牌失效/轮换、宿主退出；任一满足即取消授权轮询并关闭 callback listener，允许用户从头重试。仅原 lease重连后接续步骤，不回显已提交secret；发起 lease已失效时，已保存的凭据仍显示为“已保存待应用”，任何页面可触发应用。禁止后台永久等待授权。

## 5. 账户状态与安全边界

- 列表默认只用 metadata：provider id/name、可用认证方式、是否有存储凭据、已知来源、最近本次操作结果。`listCredentials` 不解析配置 key 命令。需要运行 `checkAuth/getAuth/refresh` 时必须知道它可能执行已有配置中的命令、OAuth刷新或网络操作，不把主动解析包装成无副作用“浏览账户”。[list](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/auth-storage.ts#L484-L488)、[config命令语义](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/resolve-config-value.ts#L138-L145)
- 特别注意 API key文本的 `!command`、`$ENV` 语义。首期网页字段应明确为**字面密钥输入**，不可无意写成可执行配置。实现前 spike确认如何按官方转义保真（`$$` / `$!`）或明确拒绝配置表达式；保持已有TUI配置可用。不自己执行浏览器传来的命令。
- 当前 M2 没有访客角色：通过链接token/密码认证的页面已有执行工具和写会话的能力，不能在文档称它为“只读访客”。M3.1 建议继续把它视为用户本人／受信任的控制端；公开共享给第三方不在本期产品范围。若想允许旁观者，必须另做权限模型而非仅隐藏按钮。
- 账号管理与项目创建增加全局影响，但不应暗增复杂RBAC。推荐清晰声明现有owner信任边界，API仍校验既有认证和Origin、令牌有效期；secret交互只绑定发起lease。远程只沿用M2的HTTPS/代理+密码。使用公网反代时认证上游回调仍优先 device/manual，**不要把 provider localhost callback 服务暴露公网**。
- token、key、完整回调URL、device code、OAuth state 和provider原始错误体均不进入聊天、会话文件、图片证据、控制台、analytics、release artifacts。审计只保留 operationId/provider/type/status/errorCode和时间。首批明确无secret的DTO，不允许泛化任意对象。
- 现有 Hub 的 `notifyAll` 和 `pendingDialogs()` 会向全部认证页面发扩展对话框；账号流程必须单独建面向发起lease的发送/恢复规则。[本仓库 Hub](../../src/extension/hub.ts) L567–576。现有网页所有控制端权限见同文件L188–197、L448–478。

## 6. 先行 spike 门槛（建议在实现承诺前完成）

| ID | spike | 通过证据 |
|---|---|---|
| M31-AUTH-S1 | 无 AgentSession 的认证运行时 | 临时HOME、合成provider；宿主无 session_start/扩展载入计数增加；密钥仍能由公开API保存到临时auth.json；同时证明不写会话文件 |
| M31-AUTH-S2 | 保存后的凭据应用：进程内原生替换与受控重启对比 | 新建credential前后get_available_models的差异；两种方式各自应用后模型出现（含空会话、已落盘会话、扩展否决）；同一历史/cwd/model/branch恢复；全程至多一个RPC写入者；选定方式并留证 |
| M31-AUTH-S3 | 四类prompt及device/callback/manual | 合成本地认证端点，无日常凭据；完整状态、取消、回调竞速和端口释放证据；发起页断线数分钟后重连仍能看到结果；非发起页取消生效 |
| M31-AUTH-S4 | 全局凭据来源与特殊字符 | auth.json/environment/runtime覆盖分别测试；字面密钥含 $ ! 的保真与无shell执行；metadata查询不触发key command |
| M31-AUTH-S5 | credential已写但同步失败 | 构造CredentialSynchronizationError；浏览器和日志不含哨兵secret，显示已保存待应用；恢复不重复登录 |

本轮没有执行这些 spike；它们属于后续经确认的实现验证工作。

## 7. 可执行验收矩阵

统一使用临时HOME、临时agentDir、合成provider和本地确定性授权服务；真实provider试用另获明确授权，并将账户类型、provider版本、授权路径、测试时间记录在支持矩阵中，不展示凭据。

| ID | 操作 | 必须观察到的结果 |
|---|---|---|
| M31-AUTH-01 | 无凭据打开账户面板 | 明确未配置；不读取secret到浏览器、不隐式登录或调用模型；列表状态不会声称远端有效 |
| M31-AUTH-02 | 输入合成API key保存，再刷新页／重启宿主 | auth文件只更新所选provider、0600新建；字段清空；模型在child应用后可选；secret不出现在wire快照/receipt/日志/会话 |
| M31-AUTH-03 | 替换一个provider，旁边另一provider已有凭据 | 另一provider原值与文件内容语义保留；仅一次写入效果；新值供下一次确定性请求使用 |
| M31-AUTH-04 | 依次text/secret/select/manual_code | 四类型均完成；未知select id、旧step、跨operation回答被拒；UI有焦点、手机键盘和可访问名称 |
| M31-AUTH-05 | device code待批准、拒绝、到期、网络中断、重试 | 明确状态、按provider轮询；取消不再轮询；失败不损坏原credential；不创建多条并行授权流程 |
| M31-AUTH-06 | callback与manual同时完成、callback端口被占 | 最多一次credential提交；另一prompt撤销；端口失败有原因和允许的回退；结束后listener关闭 |
| M31-AUTH-07 | 取消发生于答复前、token exchange中、存储后同步中 | 前两者无未授权残留写；若已提交必须显示已保存待应用；无“已取消=未改动”的错误承诺 |
| M31-AUTH-08 | 点击提交两次、重连重发、第二标签页抢答 | 同operation/step最多执行一次；非发起lease拿不到secretprompt且不能回答；其他页只见全局进度，但可以取消 |
| M31-AUTH-09 | 发起页断开数分钟后刷新（含移动端转入后台）；超过操作绝对上限或设备码到期；令牌轮换 | 断线本身不取消；原lease可恢复未提交步骤或看到最终结果，不回显secret；到期/令牌撤销中止；第二页面不能接管旧操作但可以取消 |
| M31-AUTH-10 | 当前流式回复／队列／扩展dialog未结束时开始账号修改并保存凭据 | 认证交互不受阻；保存后保持“已保存待应用”，空闲后由用户触发应用；不在模型请求中途替换运行时；无任务丢失 |
| M31-AUTH-11 | 保存成功而应用失败（进程内替换被扩展否决；回退路径下child重启失败） | 凭据保存状态真实；被否决时原运行时保持可用；服务仍可显示恢复选项；没有第二写入者；原会话可恢复，不重复提交模型提示 |
| M31-AUTH-12 | 同agentDir另一个进程刷新OAuth，同时浏览器替换或删除 | 文件合法、不丢其他provider、锁释放；最终状态有确定顺序，不将旧refresh覆盖新login；失败可重试 |
| M31-AUTH-13 | logout，分别存在env、runtime、models.json来源 | 删除仅针对保存credential；仍生效来源明确；不删除shell环境或配置，不宣称远端授权已撤销 |
| M31-AUTH-14 | 一个宿主的两项目共用agentDir，另一个独立启动的宿主使用不同agentDir | 前两者认证同作用域；第三者不受影响；浏览器不能自行更改authPath |
| M31-AUTH-15 | API key含 $、!、换行及命令表达式；已有命令型配置 | 新输入严格字面或明确拒绝，绝不执行浏览器输入；旧配置metadata枚举不执行command；没有secret保真错误 |
| M31-AUTH-16 | 对所有错误路径注入哨兵key/token/code/state | 只允许官方auth文件与发起owner的必要定向认证交互承载秘密；普通WS结果/快照/广播、其他页面、日志、浏览器持久storage、会话和测试证据均无哨兵；尤其CredentialSynchronizationError.credential/cause不被透传 |
| M31-AUTH-17 | 突然关闭终端／Ctrl+C发生在OAuth pending | host/child/认证轮询/callback listener停止；无后台认证服务，会话锁按既有策略释放 |
| M31-AUTH-18 | 外部HTTPS认证已到期、错误Origin、无token的账号API请求 | 未授权请求均拒绝；有效M2登录正常；测试中不依赖只有前端禁用按钮 |
| M31-AUTH-19 | 支持矩阵中选定的真实 API key 和一个内置设备码 OAuth 路径 | 经过明确授权后分别完成登录→新模型出现→短提示成功→注销/清理；失败不得把该provider标“已验证” |

## 8. 尚须在主计划明确的产品决定

- M3.1 对“用户无需终端完成登录”的承诺必须限定到发布支持矩阵，不承诺 IAM/ADC 或扩展任意登录流程全部GUI化。
- 远端页面是否继续等同owner：推荐维持M2，不引入guest；如果用户要共享只读体验，那是新权限需求，不要靠source IP判断owner（代理会使其失真）。
- 是否允许保存但暂缓应用：主计划决定允许。认证交互不要求空闲；保存时空闲则立即应用，否则明确显示待应用，由用户在空闲后触发，避免模糊半更新状态。
- credential全局作用域与项目配置scope必须分别标注，不能给“每项目账户”视觉暗示。
- 支持矩阵的真实试用不得擅自读取日常凭据；取得一次性明确授权或使用专用临时agentDir。本调研未触及任何凭据。
