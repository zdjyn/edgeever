# XD MediaOps M0 技术设计

状态：feature/mediaops-m0 上的待批准方案；未执行生产迁移或部署。

## 价值、风险与回滚
独立兼职账号按任务接力编辑文章，不做实时协同。主要风险是跨空间泄露、旧版本覆盖和上游同步覆盖定制代码。发布前可撤销功能分支；未来发布后须先撤销授权并关闭 MediaOps 路由，数据回滚须依赖经过验证的备份恢复。旧版到新版迁移和其他客户端仍未验证。

## 架构选择
采用 MediaOps 专用受控 API。保留每个账号现有个人 Workspace 和单成员约束；由管理员拥有一个独立的非个人 MediaOps Workspace，兼职人员不加入 workspace_members，也不切换现有 AuthContext.workspaceId。新增统一的 authorizeTask(actor, task, memo, action) 服务，普通 Workspace API 不得访问 MediaOps 数据。文章在 MediaOps 空间内创建；从私人空间复制时显式复制允许的附件并拒绝私人内部链接。通用多 Workspace 方案会扩大认证、同步、搜索、离线缓存、移动端、MCP、导出的改动面，因此 M0 不采用。

## 数据与角色
草案见 mediaops-m0-schema.sql。复用 users、memos、memo_contents、memo_revisions、memo_edit_sessions 和 resources。新表只记录任务、人员授权、文章关联和审计事件。角色为 manager（实例管理员）、editor（获派编辑）、reviewer（获派审核）；禁用账号及撤销授权须立即失效。个人及 SmartGym 内容仍按原 workspace_id 隔离。

状态：draft → in_progress → submitted → approved；submitted → changes_requested → in_progress。M0 中 approved 为终态，manager 可取消未批准任务。状态转换要求任务版本和服务端文章版本匹配，写入操作者和事件。提交前客户端须等待自动保存与离线队列得到服务端确认；服务端只能检查已提交的版本和哈希，不能假定可读取浏览器 IndexedDB。

## 权限矩阵
| 操作 | Manager | 获派 Editor | 获派 Reviewer | 其他账号 |
|---|---|---|---|---|
| 任务、文章、历史、允许的附件 | 允许 | 本任务 | 本任务 | 拒绝 |
| 创建、指派、撤销、取消 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 可编辑状态下写正文 | 允许 | 允许 | 拒绝 | 拒绝 |
| 提交审核 | 允许 | 允许 | 拒绝 | 拒绝 |
| 通过或退回 | 允许 | 拒绝 | 允许 | 拒绝 |
| 恢复历史 | 需当前版本匹配 | 拒绝 | 拒绝 | 拒绝 |
| 删除、公开分享、导出、MCP、普通同步 | M0 须单独授权，默认关闭 | 拒绝 | 拒绝 | 拒绝 |

每个服务入口都应校验任务、文章、空间及授权，附件直取也一样。对未授权 ID 返回 404，避免枚举。不得信任客户端传入的 workspace_id、角色、状态或 memo_id。

## 原子写入与上游
正文保存应在事务内验证授权和状态，以 memo_id、旧 revision、旧 content_hash 做条件 UPDATE，检查受影响行数恰为 1；再更新元信息、任务版本和事件，任一步失败整体回滚。D1 适配层的原子批处理和行数报告须实测，不能只依赖预读。历史恢复也采用相同条件写入并保留被覆盖版本。

现有定时上游工作流可能推送 main 并触发生产部署。M0 推荐本 Fork 改为“上游候选分支 → 审核 PR → CI 与隔离迁移测试 → 人工合并”，关闭自动直推和自动部署；合并 main 仍是单独的生产发布决策，因为当前 deploy 脚本会运行远程迁移。验收清单见 mediaops-m0-tests.md。
