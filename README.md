<p align="center">
  <img src="src/common/logo.png" alt="倒数日图标" />
</p>
<h1 align="center">倒数日</h1>
<p align="center">面向小米 / Redmi Vela 穿戴设备的倒数日快应用。</p>

## 功能

- 管理重要日子，查看倒计时、已过去时间和周年数。
- 支持公历 / 农历、年度重复，以及天 / 周 / 月 / 年显示。
- 支持置顶、分类、归档、手动排序、快捷模板和近期事项。
- 独立键盘输入，多语言与胶囊 / 方形 / 圆形屏幕布局。
- 通过 [AstroBox 配套插件](https://github.com/sf-yuzifu/Daymatter-AstroBox-Plugin)管理事件、备份恢复和上传背景。
- 独立表盘主事件联动，自定义背景与恢复默认。

## 预览

<p align="center">
  <img src="images/band.png" alt="胶囊屏" />
  <img src="images/pro.png" alt="方屏手环" />
  <img src="images/rw.png" alt="方屏手表" />
  <img src="images/s.png" alt="圆屏手表" />
</p>

## 使用

安装 RPK 后新建事件，填写名称和日期，按需设置重复、显示单位和首页展示。键盘确认只更新草稿，编辑页保存后才提交。

列表顶部提供排序与筛选；“关于”页可恢复默认背景。插件与腕端建议同时更新，新功能通过能力协商启用。

设备兼容性以实际型号和固件验证为准。应用退出期间不保证年度表盘日期后台更新，重新打开应用后维护。

## 开发

需要 Node.js ≥18.18，使用 Yarn 安装锁定依赖。

```bash
yarn install --frozen-lockfile
npm run start       # 开发调试
npm run check       # 只读工程检查
npm test           # 本地回归
npm run release    # 发布构建，包含 JSC
```

产物位于 `dist/`，发布构建需要本地 `sign/` 签名材料。

详细说明见 [开发指南](docs/development.md) 和 [文档目录](docs/README.md)。

## 文档与反馈

- [事件模型与日期规则](docs/event-model.md)
- [同步协议与兼容性](docs/sync-compatibility.md)
- [备份与恢复](docs/backup.md)
- [背景图片与分片传输](docs/background-transfer.md)

欢迎提交 Issue / PR。问题反馈请附设备型号、固件、两端及 AstroBox 版本、复现步骤和日志或截图。

## 许可证与致谢

本项目采用 [GPL-3.0-or-later](LICENSE)。第三方来源见 [来源记录](docs/third-party-notices.md)。

感谢 [chiyuki0325](https://github.com/chiyuki0325/)（原始项目）、[无源流沙](https://www.bandbbs.cn/threads/14584/)（界面设计）、[NEORUAA](https://github.com/NEORUAA/)（输入法）。
