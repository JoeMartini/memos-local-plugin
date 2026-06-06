# MemOS + gbrain 融合部署 — 经验教训

## 事件时间线

| 时间 | 事件 |
|------|------|
| 2025-06-05 00:22 | 安装 MemOS Local Plugin v2.0.6 |
| 2025-06-05 00:28 | install.sh 正确设置 memory.provider = memtensor（创建 .bak.memos 备份） |
| 2025-06-05 00:28 | **错误：全局 sed 替换 sky profile 的所有 provider 为 memtensor** |
| 2025-06-05 08:52 | 首次出现 `Unknown provider 'memtensor'` 错误 |
| 2025-06-05 14:30 | 根因分析：确认是全局替换导致 model.provider 被覆盖 |
| 2025-06-05 14:35 | 修复：从 .bak.memos 恢复 sky config，只设置 memory.provider |
| 2025-06-05 14:44 | 端到端验证通过：5 条 traces 成功同步到 gbrain |

## 错误根因

使用 `sed -i 's/provider:.*/provider: memtensor/'` 全局替换 `config.yaml`，误将以下字段全部改为 memtensor：
- `model.provider` → 应为 `custom`
- 所有 tool providers → 应为各自的值
- `delegation.provider` → 应为 `''`

## 正确做法

```python
import yaml

with open('config.yaml') as f:
    config = yaml.safe_load(f)

# 只修改目标字段
config.setdefault('memory', {})['provider'] = 'memtensor'

with open('config.yaml', 'w') as f:
    yaml.dump(config, f, default_flow_style=False)
```

## 防范清单

- [ ] 修改前：`cp config.yaml config.yaml.bak.$(date +%Y%m%d_%H%M%S)`
- [ ] 修改时：只用 Python yaml 库精确操作目标字段
- [ ] 修改后：`diff config.yaml.bak.* config.yaml` 确认只改了预期字段
- [ ] 绝不用：全局 sed / grep+replace / vim 批量替换 config.yaml

## 架构验证

| 检查项 | 状态 |
|--------|------|
| MemOS Bridge 启动 | ✅ `pipeline.ready agent="hermes"` |
| Profile 配置 | ✅ default/martini/sky 均 memory.provider=memtensor |
| 桥接脚本 | ✅ 可执行，dry-run 正常 |
| 数据同步 | ✅ 5 traces → gbrain import OK |
| gbrain 查询 | ✅ `MemOS gbrain bridge` 返回 MemOS traces |
| Cron 定时 | ✅ 每日 02:00 |
| Notion 记录 | ✅ 已更新 "记忆管理系统 v2.0" 页面 |
