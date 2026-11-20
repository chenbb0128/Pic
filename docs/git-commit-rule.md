# Git Commit Message Generation Prompt

当需要生成 git 提交信息时，请按照以下要求执行：

## 基本要求

1. **不要执行提交命令** - 只生成提交信息文本内容
2. **只考虑 staged 的内容** - 使用 `git diff --staged` 查看暂存区的变更
3. **过滤无关内容** - 不要包含类似 `(cci:1://file://XXXXXXXXXXXXXXX)` 等编辑器特定的内容
4. **提供中英文对照** - 生成两个独立的 markdown 文档，一个中文，一个英文

## 输出格式要求

### 文档结构

**中文文档：**
```markdown
feat: [简短的功能描述，不超过50字]

**前端:**
- [变更内容1]
- [变更内容2]
...

**后端:**
- [变更内容1]
- [变更内容2]
...

**UX/UI 交互:**
- [变更内容1]
- [变更内容2]
...
```

**英文文档：**
```markdown
feat: [Short feature description, no more than 50 words]

**Frontend:**
- [Change 1]
- [Change 2]
...

**Backend:**
- [Change 1]
- [Change 2]
...

**UX/UI:**
- [Change 1]
- [Change 2]
...
```

### 标题前缀规则

根据变更类型使用对应的前缀：
- **功能开发**: `feat:`
- **Bug 修复**: `fix:`
- **代码重构**: `refactor:`
- **性能优化**: `perf:`
- **文档更新**: `docs:`
- **样式调整**: `style:`
- **测试相关**: `test:`
- **构建相关**: `build:`
- **CI/CD 相关**: `ci:`
- **回退变更**: `revert:`

### 分类规则

将变更内容分为以下三类：

**前端:**
- React/TypeScript 组件变更
- 前端页面/视图变更
- 前端 hooks 和工具函数
- 前端状态管理
- 样式和 UI 组件库

**后端:**
- Rust/Go/Python 等后端代码
- 数据库相关代码
- API 接口和命令
- 配置文件
- 依赖管理文件

**UX/UI 交互:**
- 用户界面交互优化
- 用户体验改进
- 交互逻辑调整
- 动画和过渡效果
- 响应式布局优化

### 空分类处理

如果某个分类没有变更，**不要输出该分类**，也不要输出类似"本次提交无前端变更"这样的内容。

### 内容描述规范

- 每条变更描述简洁明了，使用动词开头
- 中文描述使用简体中文
- 英文描述使用英文
- 避免技术细节，关注功能和影响
- 相关联的变更可以合并为一条

## 示例

### 中文示例
```markdown
feat: 实现微信数据库智能同步与虚拟挂载功能，优化数据库查询性能

**前端:**
- 重构聊天气泡组件，优化消息展示效果
- 更新消息解析工具，增强消息内容处理能力
- 优化连接钩子，改进数据库连接状态管理
- 新增数据库测试视图，提供数据库功能调试界面

**后端:**
- 新增智能同步模块，实现微信数据库自动解密与虚拟挂载
- 实现数据库分片策略，支持物理合并与虚拟附加两种挂载模式
- 新增消息解析器，支持 XML 格式消息解析
- 重构数据库连接池，优化多线程并发性能

**UX/UI 交互:**
- 优化聊天界面消息渲染，支持更丰富的消息类型展示
- 改进数据库测试视图交互体验，提供分页加载功能
```

### 英文示例
```markdown
feat: Implement WeChat database smart sync and virtual mounting features, optimize database query performance

**Frontend:**
- Refactored chat bubble component for improved message display
- Updated message parser utility with enhanced message content processing
- Optimized connection hook for better database connection state management
- Added database test view providing database function debugging interface

**Backend:**
- Added smart sync module for automatic WeChat database decryption and virtual mounting
- Implemented database shard strategies supporting both physical merge and virtual attach modes
- Added message parser for XML format message parsing
- Refactored database connection pool for improved multi-threaded concurrency performance

**UX/UI:**
- Optimized chat interface message rendering with support for richer message types
- Improved database test view interaction experience with pagination loading
```

## 使用方法

当需要生成 git 提交信息时：
1. 运行 `git diff --staged` 查看暂存区变更
2. 分析变更内容，确定类型和分类
3. 根据上述格式要求生成中英文两个文档
4. 输出两个独立的 markdown 文档内容
