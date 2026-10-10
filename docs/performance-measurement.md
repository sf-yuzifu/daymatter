# 返回页面耗时诊断

默认关闭。调试时在应用启动后、操作前设置 `global.daymatterPerfEnabled = true`，或临时在 `src/app.ux` 服务初始化前设置该标记并构建调试包。结束后设置为 false 并清空 `global.daymatterPerfRecords`；正式交付不要保留启用标记。

最近64条标量记录保存在 `global.daymatterPerfRecords`，并通过 `[daymatter:perf]` 日志输出（当前release的error日志级别可能过滤info，调试时可查看记录或使用debug日志级别）。不记录名称、文件正文或页面对象。

| 阶段 | 含义 |
| --- | --- |
| store.readQueue | 读取等待在途写入或表盘维护的时间 |
| store.fileRead | 文件接口耗时；失败也记录 |
| store.parseValidate | JSON解析与模型校验/归一化 |
| store.watchfaceMaintenance | UI数据回调后的迁移/表盘派生维护 |
| home.read / list.read | 调用读取至收到页面数据，包含队列等待 |
| home.selectSort / list.selectSort | 筛选与排序 |
| home.formatSlots / list.formatPage | 当前槽位/页格式化与数据赋值 |
| home.nextTick / list.nextTick | 赋值后至框架下一轮回调，**不是实际绘制完成或帧率**；无nextTick的平台不记录 |

阶段存在嵌套，不能直接全部相加。Date.now毫秒分辨率会将短阶段记为0ms。

用0/10/30/100/200条、长名称及农历年度事件，分别测冷启动、首页→列表→返回、编辑保存返回和取消返回，每场景重复10次；记录设备、固件、事件规模、阶段中位数/慢值和可获取的原生绘制信息。失败、跨午夜、外部插件修改后回读也需要核对。

本地可运行 `node tools/benchmark-store-read.cjs`。以Git HEAD为旧实现，使用同步内存文件及跳过写入的表盘模拟，只比较正常读取次数及JS解析/校验，不代表设备I/O、页面渲染或整体启动提升。

当前保留每次返回真实读取，未引入长期完整快照。正常读取及表盘维护共用一次有序读取；迁移、损坏恢复、move202回读等特殊路径可能有额外I/O。UI数据先回调，表盘维护完成前后续队列任务等待，以免旧快照覆写新主事件。
