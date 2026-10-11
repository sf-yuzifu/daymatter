# 倒数日联动表盘

适配小米 Band 9、Band 10、Band 9 Pro、Watch S4。公共 Lua 读取倒数日快应用的主事件，显示时间、日期、电量和倒数日；没有主事件时显示每年 6 月 7 日的高考倒计时，当天显示今天，次日切换下一年。

## 结构

- `src/logic.lua`：纯日期、接口解析与数据校验。
- `src/daymatter.lua`：公共 UI、订阅与刷新入口。
- `devices.json`：四款布局与 EasyFace DeviceType。
- `png/`：四款共用的数字、冒号、倒数日框与今天图案，Lua 直接读取 PNG。
- `devices/<型号>/`：各款背景 `bg.bin` 与预览；其余素材统一来自 `png/`。
- `tools/build.py`：生成每款 EasyFace 工程，内嵌公共逻辑与设备配置，不依赖额外 Lua 模块加载。
- `build/<型号>/daymatter.fprj`：生成的工程。
- `dist/daymatter-<型号>.face`：编译产物。

根目录旧 `app/` 和 `.fprj` 是原 Band 9 工程留档；新版本从 `src/` 生成，勿在生成文件中维护源码。

## 生成与打包

需要 Python 3 和 EasyFace 编译器。在仓库根目录执行：

```powershell
python tools/build.py
python tools/build.py --device band10
python tools/build.py --compiler "D:\project\daymatter-watchface\watchface\tools\Compiler.exe"
```

也可在 EasyFace 打开生成的 `.fprj` 手动编译。默认表盘 ID 为 `252661004`，可用 `--id` 指定。Band 10 已修正为 212×520、DeviceType 466；设备编号由本地 Compiler.exe 内嵌 XiaomiWatch.Common 4.15.0.0 的 WatchType 枚举核实。

资源已经独立保存，正常生成不依赖旧分支。`--import-assets` 仅用于从原远程跟踪分支重新导入，遇到不同内容不会覆盖现有资源。

## 主事件接口与兼容性

读取 `/data/quickapp/files/com.yzf.daymatter/date.txt`，格式 `名称,YYYY-MM-DD,true/false`。缺失、空文件或非法内容回退高考占位，后续继续重试。计入起始日只影响今天与过去，统一四款行为；超过 9999 天显示 9999 并在目标日文本标明超限。

创建与亮屏立即刷新，亮屏时借用既有秒订阅每约 5 秒检查一次文件；熄屏停止文件轮询。不引入计时器或订阅暂停接口。显示内容不变时跳过倒数日 UI 更新。前景素材直接使用共用 PNG，不转换为 BIN；背景仍使用原 `bg.bin`，本轮不接自定义背景。

年度/农历主事件沿用快应用导出的公历发生日。文件不包含重复规则，快应用退出期间的年度日期滚动仍需重新打开快应用维护；高考占位由表盘独立滚动。

## 验证

```powershell
python -m pip install lupa
python tools/build.py
python tools/test.py
```

测试使用 Lua 5.4，覆盖真实公共逻辑与四份生成入口：日期边界、计入起始日、年度高考占位、异常文件、无效订阅、超限数字和亮灭屏轮询。UI 测试使用模拟 API；EasyFace 打包不等于设备运行验证。

实机验收：四款布局/字体、主事件设置与取消、跨午夜、时间电量订阅、熄屏再亮屏和文件读取。原字体按设备尝试 MiSans，失败回退内置字体；中文字体是否正确仍须实机核对。

![Band 9 预览](devices/band9/preview.png)
