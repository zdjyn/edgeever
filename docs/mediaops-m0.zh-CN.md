# XD MediaOps M0 技术设计

状态：feature/mediaops-m0 上的待批准方案；未执行生产迁移或部署。

## M0 实现补充
已确认采用 MediaOps 专用受控 API。0088 迁移建立任务授权、单一持有人及递增持有人代次、不可变批准快照、事件和 CAS 断言表。Manager 首次创建任务时，在同一事务中按需建立独立非个人空间和笔记本，单纯升级不会改变现有空间数量。Manager 独有最终批准权；Reviewer 可标记已审查或退回；Editor 仅在 draft、in_progress、changes_requested 状态且持有当前编辑权时写入。退回后须重新提交审核；任何已批准稿的后续修改也须重新走审核，原批准快照不能覆盖。AI 预留独立 ai 授权角色，但现阶段 API/MCP agent 一律拒绝，待任务绑定服务凭据完成后才开放。

正文写入在同一 batch 中按旧 revision/hash、当前持有人代次、状态、有效授权、账号启用和 MediaOps 空间做条件更新。紧随的 SQL 断言检查 changes() 恰为 1；CHECK 失败使整批 D1 写入回滚，包括修订、元数据和事件。Cloudflare 官方说明 D1 batch 是事务，语句失败会回滚整个序列：https://developers.cloudflare.com/d1/worker-api/d1-database/#batch 。本地 SQLite 已测，真实 D1 行为仍须 staging 验收。

浏览器 /mediaops 是基础任务页，使用显式保存；冲突时保留可复制的本地文本，提交仅发送已确认的服务端版本。服务端不能读取其他设备的 IndexedDB 队列。任务指派和交接已有 API，完整管理界面及离线队列整合仍待后续实现。

## 当前 main 上游同步安全处置（须负责人单独批准）
功能分支内的工作流保护条件对当前 main 尚无效。负责人需单独批准：在 GitHub 停用定时的“Update deployed EdgeEver”工作流，或仅将 Fork 专属保护条件以最小 PR 合入 main；这两种操作均不更改 Cloudflare。批准并执行前，当前 main 的自动更新仍可能覆盖定制代码。之后实现“上游候选分支 → PR → CI 与旧版迁移测试 → 人工审核合并”，候选工作流不得直接推送 main 或调用部署钩子。现有 deploy:ci 会运行远程迁移，不能作为 staging 命令使用。

## Staging 隔离门禁
仓库中的配置只是模板，不代表已观察到真实部署。任何 Cloudflare 变更前，先只读记录生产 Worker 名称与路由、D1 UUID、R2 正式与预览桶、构建部署命令及 Secret 名称，私下保存清单。获得单独批准后才创建全新的 staging 资源；staging Secret 须重新随机生成，单看 Secret 名称不能证明值不同。把新 D1 UUID 填入模板的本地副本，并用 verify-mediaops-staging.mjs 对照真实生产清单。每次 staging 迁移和部署都必须显式指定该配置，禁止使用仓库通用 deploy:ci、db:migrate:remote 或生产 Cloudflare Builds 连接。合成数据测试前后只读记录生产健康状态、版本及资源元数据。真实隔离须在两个实际环境完成这些检查后才能验收。

## 价值、风险与回滚
独立兼职账号按任务接力编辑文章，不做实时协同。主要风险是跨空间泄露、旧版本覆盖和上游同步覆盖定制代码。发布前可撤销功能分支；未来发布后须先撤销授权并关闭 MediaOps 路由，数据回滚须依赖经过验证的备份恢复。旧版到新版迁移和其他客户端仍未验证。

## 架构选择
采用 MediaOps 专用受控 API。保留每个账号现有个人 Workspace 和单成员约束；由管理员拥有一个独立的非个人 MediaOps Workspace，兼职人员不加入 workspace_members，也不切换现有 AuthContext.workspaceId。新增统一的 authorizeTask(actor, task, memo, action) 服务，普通 Workspace API 不得访问 MediaOps 数据。文章在 MediaOps 空间内创建；从私人空间复制时显式复制允许的附件并拒绝私人内部链接。通用多 Workspace 方案会扩大认证、同步、搜索、离线缓存、移动端、MCP、导出的改动面，因此 M0 不采用。

## 数据与角色
草案见 mediaops-m0-schema.sql。复用 users、memos、memo_contents、memo_revisions、memo_edit_sessions 和 resources。新表只记录任务、人员授权、文章关联和审计事件。角色为 manager（实例管理员）、editor（获派编辑）、reviewer（获派审核）；禁用账号及撤销授权须立即失效。个人及 SmartGym 内容仍按原 workspace_id 隔离。

状态：draft → in_progress → submitted → reviewed → approved；submitted → changes_requested → in_progress。Manager 恢复历史也会进入 changes_requested，原批准快照不变。取消状态暂未开放 M0 接口。状态转换要求任务版本和服务端文章版本匹配，写入操作者和事件。提交前客户端须等待自动保存与离线队列得到服务端确认；服务端只能检查已提交的版本和哈希，不能假定可读取浏览器 IndexedDB。

## 权限矩阵
| 操作 | Manager | 获派 Editor | 获派 Reviewer | 其他账号 |
|---|---|---|---|---|
| 任务、文章、历史、允许的附件 | 允许 | 本任务 | 本任务 | 拒绝 |
| 创建、指派、撤销、取消 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 可编辑状态下写正文 | 允许 | 允许 | 拒绝 | 拒绝 |
| 提交审核 | 仅同时获派 Editor 且持有编辑权 | 当前持有人允许 | 拒绝 | 拒绝 |
| 标记已审或退回 | 允许 | 拒绝 | 允许 | 拒绝 |
| 最终批准已审稿 | 独有 | 拒绝 | 拒绝 | 拒绝 |
| 恢复历史 | 需当前版本匹配 | 拒绝 | 拒绝 | 拒绝 |
| 删除、公开分享、导出、MCP、普通同步 | M0 须单独授权，默认关闭 | 拒绝 | 拒绝 | 拒绝 |

每个服务入口都应校验任务、文章、空间及授权，附件直取也一样。对未授权 ID 返回 404，避免枚举。不得信任客户端传入的 workspace_id、角色、状态或 memo_id。

## 原子写入与上游
正文保存应在事务内验证授权和状态，以 memo_id、旧 revision、旧 content_hash 做条件 UPDATE，检查受影响行数恰为 1；再更新元信息、任务版本和事件，任一步失败整体回滚。D1 适配层的原子批处理和行数报告须实测，不能只依赖预读。历史恢复也采用相同条件写入并保留被覆盖版本。

现有定时上游工作流可能推送 main 并触发生产部署。M0 推荐本 Fork 改为“上游候选分支 → 审核 PR → CI 与隔离迁移测试 → 人工合并”，关闭自动直推和自动部署；合并 main 仍是单独的生产发布决策，因为当前 deploy 脚本会运行远程迁移。验收清单见 mediaops-m0-tests.md。
