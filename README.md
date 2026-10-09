<p align="center">
  <img src="src/common/logo.png" alt="倒数日图标" />
</p>
<h1 align="center">倒数日 快应用</h1>
<p align="center">面向小米 / Redmi Vela 穿戴设备的倒数日工具，在手腕上管理重要日子。</p>

## ✨ 功能特性

- **事件管理**：添加、编辑、删除事件，查看目标日的倒计时或已过去时间。
- **年度重复**：保留原始日期，计算本次 / 下次发生日和周年数；非闰年的 2 月 29 日按 2 月 28 日处理。
- **农历日期**：离线支持农历1900～2100年，保留原始农历与闰月；年度无对应闰月按普通同月，三十遇小月按月末。
- **独立显示单位**：每个事件分别保存天、周、月、年的显示偏好。
- **排序与置顶**：支持创建顺序、临近日期和手动顺序，首页与列表共用排序规则。
- **分类与归档**：提供未分类、生日、学习、生活、纪念日分类；归档保留数据，可随时恢复。
- **快捷模板与近期事项**：生日、考试、纪念日模板生成新增草稿；列表可查看今天和未来 30 天事项。
- **便捷输入**：沿用[腕上漫画](https://github.com/sf-yuzifu/bandcomic)的独立键盘页面，基于[喵喵输入法](https://github.com/NEORUAA/Vela_input_method)。
- **表盘联动**：独立选择表盘主事件，提交后维护表盘数据文件。
- **AstroBox 联动**：通过[配套插件](https://github.com/sf-yuzifu/Daymatter-AstroBox-Plugin)管理腕端事件、同步列表和上传背景。
- **JSON 备份与恢复**：插件导出完整事件数据，校验预览后按合并或替换恢复。
- **多语言与多屏布局**：提供简体中文、繁体中文和英文文案，针对胶囊、方形、圆形屏幕设计布局。

界面采用[无源流沙](https://www.bandbbs.cn/threads/14584/)的设计风格。具体设备、固件的渲染与触控兼容性仍需实际验证，多屏布局不等同于所有型号均已通过测试。

## 📱 预览

<p align="center">
  <img src="images/band.png" alt="手环界面预览" />
  <img src="images/pro.png" alt="方屏手环界面预览" />
  <img src="images/rw.png" alt="方屏手表界面预览" />
  <img src="images/s.png" alt="圆屏手表界面预览" />
</p>

## ⌚ 使用说明

1. 在支持 Vela 快应用的设备上安装 RPK，打开倒数日。
2. 新建事件，填写名称与日期，按需设置年度重复、显示单位和首页展示。
3. 键盘确认只更新编辑草稿；返回键取消输入，编辑页点击保存才提交事件。
4. 在列表顶部展开“排序与筛选”，切换排序、分类或正常 / 已归档事件。
5. 在编辑页设置置顶、归档和手动移动；表盘主事件与首页展示、置顶互相独立。
6. 在「关于」页查看当前背景状态；自定义背景可点击「恢复默认」，确认后恢复黑色底色。

事件和日期规则见[事件数据模型](docs/event-model.md)。AstroBox 宿主门槛、新旧端互通及已知背景限制见[同步与兼容说明](docs/sync-compatibility.md)。

年度事件的表盘日期在应用提交、页面进入或前台跨午夜时维护。应用退出期间没有可靠后台调度，需要重新打开应用才能更新年度发生日。

## 🛠️ 开发与构建

### 环境要求

- Node.js ≥18.10。
- Yarn：仓库使用 `yarn.lock` 锁定依赖。
- 构建工具：`aiot-toolkit` 与 JSC 编译器，由项目依赖提供。

```bash
# 安装依赖
yarn

# 开发调试
npm run start

# 普通构建
npm run build

# 发布构建（包含 JSC 编译）
npm run release
```

也可以使用对应的 `yarn start`、`yarn build`、`yarn release` 命令。产物位于 `dist/`，发布构建使用本地 `sign/` 签名材料；签名文件不纳入版本控制。

### 本地验证

| 命令 | 验证范围 |
| --- | --- |
| `npm run test:ime` | 键盘确认 / 取消、编辑草稿、页面生命周期及同步协议模拟 |
| `npm run test:date` | 日期归一、非法日期、计入起始日、月末、闰年与年度重复 |
| `npm run test:store` | 稳定 ID、旧数据迁移、串行提交、校验与写入失败恢复 |
| `npm run test:watchface` | 主事件选择、替代 / 清空、表盘文件及失败补写 |
| `node --test tools/test-background.cjs` | 背景安全替换、失败保留、在途隔离与迟到扫描 |
| `npm run test:memory` | Node 页面栈与资源释放模拟，输出 GC 前后 JS 堆数值 |

运行全部主要回归：

```bash
node --test tools/test-ime.cjs tools/test-date.cjs tools/test-store.cjs tools/test-watchface.cjs tools/test-background.cjs
```

这些工具运行实际页面脚本或纯逻辑，但不能替代设备上的渲染、触控、文件系统与内存测试。内存模拟数值来自 Node，不代表 Vela 的 JS 堆或原生内存。

发布包保持完整CSS属性名，不启用`--optimize-css-attr`：手环9 Pro固件3.1.171日志明确拒绝缩写属性，导致布局失效。构建后运行`node tools/check-release-css.cjs`检查实际RPK字节码中的完整属性与不支持的justifyItems。

### 资源与包体工具

```bash
# 无损优化 PNG，校验解码后的 RGBA 像素一致
npm run optimize:png

# 只检查可优化空间，不改写图片
node tools/optimize-png.cjs --check

# 检查图片尺寸和解码预算
npm run check:budget

# 分析已有 release RPK
npm run analyze:size

# 与固定历史基线对比
npm run analyze:size -- --baseline tools/size-baseline.json

# 输出 JSON 报告
node tools/analyze-size.cjs --json
```

包体分析只读取已有产物，输出压缩 / 未压缩体积、文件数、SHA-256、构建元数据与可核实的签名指纹。`tools/size-baseline.json` 是历史 `2.1 / 21001` 发布包基线；比较时应核对构建参数和签名方式。图片编码体积、包体大小均不代表运行内存。

## 📁 项目结构

```text
daymatter/
├── src/
│   ├── common/           # 图片、样式、字体
│   ├── components/       # 日期、排序、存储、通信与表盘逻辑
│   ├── i18n/             # 语言文件
│   ├── pages/
│   │   ├── index/        # 首页
│   │   ├── list/         # 事件列表与筛选
│   │   ├── edit/         # 编辑页
│   │   ├── datepicker/   # 日期选择器
│   │   ├── ime/          # 独立键盘与输入法资源
│   │   └── about/        # 关于页
│   ├── app.ux            # 应用入口
│   ├── manifest.json     # 应用配置
│   └── config-watch.json # 手表配置
├── docs/                 # 数据模型与同步兼容说明
├── tools/                # 回归、资源和包体工具
├── images/               # 文档预览图片
├── package.json          # 依赖与开发命令
└── yarn.lock             # 依赖版本锁定
```

`node_modules/` 是安装依赖，`build/` 是构建中间产物，`dist/` 是生成的 RPK，均不提交 Git，可以重新安装或构建生成。`sign/` 是需要保留的本地签名材料。编辑器配置、开发待办与历史记录保留在本地。

`.prettierrc.js` 提供编辑器格式化规则；目前未配置项目级 lint / 格式检查命令。

## 📚 文档与贡献

- [事件数据模型](docs/event-model.md)：字段、日期、排序、归档、存储与表盘规则。
- [JSON 备份与恢复](docs/backup.md)：文件格式、冲突处理、合并 / 替换与预算。
- [农历支持评估与实施](docs/lunar-evaluation.md)：离线换算、闰月、范围、验证与体积记录。
- [同步与兼容说明](docs/sync-compatibility.md)：能力协商、保存确认、新旧端行为和验证范围。
- [Vela 快应用官方文档](https://iot.mi.com/vela/quickapp)：平台 API 与开发指南。

欢迎提交 Issue 和 Pull Request。反馈问题时请附设备型号、固件、应用 / 插件 / AstroBox 版本、复现步骤及日志或截图。

## 📄 许可证

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证开源。

## 🙏 致谢

- [chiyuki0325](https://github.com/chiyuki0325/)：原始项目作者。
- [无源流沙](https://www.bandbbs.cn/threads/14584/)：UI 界面设计。
- [NEORUAA](https://github.com/NEORUAA/)：输入法组件。
- [腕上漫画](https://github.com/sf-yuzifu/bandcomic)：独立键盘页面与适配参考。
