# 倒数日联动表盘

适配小米 Band 9、Band 10、Band 9 Pro、Watch S4，并提供 Band 10 Pro、Redmi Watch 6 的待实机验证适配。公共 Lua 读取倒数日快应用的主事件，显示时间、日期、电量和倒数日；没有主事件时显示每年 6 月 7 日的高考倒计时，当天显示今天，次日切换下一年。

## 结构

- `src/logic.lua`：纯日期、接口解析与数据校验。
- `src/daymatter.lua`：公共 UI、订阅与刷新入口。
- `devices.json`：设备布局与 EasyFace DeviceType；新款复用资源而不复制设备目录。
- `assets/common/`：共用数字、冒号、倒数日框与今天图案，Lua 直接读取 PNG。
- `assets/preview-base.png`：各设备预览的统一底版。
- `devices/<型号>/`：设备专用背景、卡片与自动生成预览；10 Pro 复用 9 Pro，S5 41mm 复用 S4。
- `tools/build.py`：生成每款 EasyFace 工程，内嵌公共逻辑与设备配置，不依赖额外 Lua 模块加载。
- `build/<型号>/daymatter.fprj`：生成的工程。
- `dist/daymatter-<型号>.face`：编译产物。

根目录旧 `app/` 和 `.fprj` 是原 Band 9 工程留档；新版本从 `src/` 生成，勿在生成文件中维护源码。

## 生成与打包

需要 Python 3、Pillow 和 EasyFace 编译器。在仓库根目录执行 `python -m pip install -r requirements.txt` 安装开发依赖，然后执行：

```powershell
python tools/build.py
python tools/build.py --device band10
python tools/build.py --compiler "D:\project\daymatter-watchface\watchface\tools\Compiler.exe"
```

也可在 EasyFace 打开生成的 `.fprj` 手动编译。默认表盘 ID 为 `252661004`，可用 `--id` 指定。Band 10 已修正为 212×520、DeviceType 466；设备编号由本地 Compiler.exe 内嵌 XiaomiWatch.Common 4.15.0.0 的 WatchType 枚举核实。

资源已经独立保存，正常生成不依赖旧分支。每次构建自动从 `assets/preview-base.png` 生成预览：水平和竖直居中等比裁剪，手环为胶囊圆角（半径为宽度的一半），Pro 为 48px，Redmi Watch 为 104px，圆屏为圆形。边缘抗锯齿，外侧透明；可单独运行 `python tools/previews.py`。S5 41mm 复用 S4 预览，打包时为适应编译器检查将其放大到 480×480，运行布局仍为 466×466。

S4 设备目录保留 466×466 预览，打包预览按 EasyFace 要求缩为 464×464。编译使用独立暂存目录，只有本次新产物生成成功才更新 `dist/`，避免编译器返回成功退出码但实际失败时误用旧包。

### 新设备（需要 EasyFace 4.23）

| 目标 | 分辨率 | DeviceType | 布局与资源 |
| --- | --- | --- | --- |
| `band10pro` | 336×480 | 567 | 复用 9 Pro 布局、背景、预览；优先 MiSans-Demibold |
| `redmiwatch6` | 432×514 | 565 | 卡片整体居中；黑色背景与占位预览；优先 MiSans-Regular |
| `s5_46` | 480×480 | 562 | 圆屏卡片整体居中；黑色背景与占位预览；优先 MiSans-Demibold |

S5 46mm 屏幕尺寸来自编译器内嵌 WatchScreen；设备库 XML 未列出此机型，但编译器已能识别并打包 MiWatchS5。46mm 的实际显示仍需实机确认。用户确认 S5 41mm 与 S4 同为 466×466，`s5_41` 在生成时复用 S4 布局，使用黑色背景、MiSans-Demibold 与 S5 DeviceType 562。没有单独确认 41mm 的设备编号，产物 `daymatter-s5_41.face` 的安装兼容性仍需实机验证。

EasyFace 4.23 对 DeviceType 562 强制要求 480×480 预览，因此 S5 41mm 使用 480×480 黑色打包预览，Lua 布局仍为 466×466。这只是满足编译器检查，不代表确认了 41mm 的包格式兼容性。

手环 11 官方规格为 212×520，与手环 10 相同。`--device band11` 复用 Band 10 工程，输出 `daymatter-band11-test.face`（与 `daymatter-band10.face` 字节相同），用于验证用户提出的共包兼容性；没有猜测手环 11 DeviceType。安装、PNG、字体与订阅成功前，不标记为已验证支持。

编号和尺寸由 EasyFace 4.23 的 DeviceInfo.db 与 WatchType 枚举核实。4.15 不支持这两款，新设备必须使用 4.23 编译器：

```powershell
python tools/build.py --device band10pro --compiler "<EasyFace 4.23目录>\Compiler.exe"
python tools/build.py --device redmiwatch6 --compiler "<EasyFace 4.23目录>\Compiler.exe"
```

参考的三个 resource.bin 内容完全相同，使用动态屏幕尺寸和 MiSans-Regular，不能据文件名确认设备归属。两款新设备已经通过打包和 Lua 模拟 API 回归，仍需各自实机验证 PNG、字体、订阅和文件联动。Redmi Watch 6 列表预览目前是黑色占位，待实机截图后替换。

## 主事件接口与兼容性

### 当前图片映射

运行界面的背景直接读取设备目录中的 PNG，共用前景来自 `assets/common/`，生成目录不再包含旧 `bg.bin`：

| 设备 | 背景 | 卡片 |
| --- | --- | --- |
| Band 9 | `bg9.png`（192×490） | `before_9.png` / `later_9.png`（180×156） |
| Band 10 / 11 测试包 | `bg10.png`（212×520） | 通用 200×156 卡片 |
| Band 9 Pro / 10 Pro | `bg9p.png`（336×480） | 通用卡片 |
| S4 / S5 41mm | `bgs4.png`（466×466） | 通用卡片 |
| S5 46mm | `bgs5.png`（480×480） | 通用卡片 |
| Redmi Watch 6 | `bgrw6.png`（432×514） | 通用卡片 |

本表替代前文适配初期的背景与占位预览说明；设备目录中的旧 BIN 已删除。所有列表预览现均使用统一沙漏底版。

优先读取 `/data/quickapp/files/com.yzf.daymatter/date.txt`，不存在时尝试 `/data/files/com.yzf.daymatter/date.txt`，兼容不同设备的文件映射。格式 `名称,YYYY-MM-DD,true/false`。优先路径存在但为空、损坏或读取失败时不读取另一目录的旧事件，回退高考占位；每次轮询重新检查路径。两处均缺失时也回退占位。计入起始日只影响今天与过去；超过 9999 天显示 9999 并在目标日文本标明超限。

创建与亮屏立即刷新，亮屏时借用既有秒订阅每约 5 秒检查一次文件；熄屏停止文件轮询。不引入计时器或订阅暂停接口。显示内容不变时跳过倒数日 UI 更新。前景与背景直接使用 PNG，不转换为 BIN。

### 自定义背景联动

读取与主事件相同的两种应用目录下的 `background.txt`，优先主目录，打不开才尝试备用。内容仅接受快应用导出的 `bg_<数字>.png/jpg` 文件名，从接口所在目录加载图片。创建、亮屏与亮屏期间轮询检查；成功加载的引用未变化时不重新解码。空引用、非法名称、图片缺失、解码失败或尺寸不匹配时恢复设备自带背景，失败引用在后续轮询重试。支持插件上传、更换背景以及快应用恢复默认；不扫描历史图片。背景独立刷新，不受主事件是否变化影响。

年度/农历主事件沿用快应用导出的公历发生日。文件不包含重复规则，快应用退出期间的年度日期滚动仍需重新打开快应用维护；高考占位由表盘独立滚动。

## 验证

```powershell
python -m pip install lupa
python tools/build.py
python tools/test.py
```

测试使用 Lua 5.4，覆盖真实公共逻辑与八份生成入口：日期边界、计入起始日、年度高考占位、异常文件、无效订阅、超限数字和亮灭屏轮询。UI 测试使用模拟 API；EasyFace 打包不等于设备运行验证。

实机验收：四款布局/字体、主事件设置与取消、跨午夜、时间电量订阅、熄屏再亮屏和文件读取。9 Pro 直接优先尝试 `MiSans-Demibold`，加载报错或返回空值时依次尝试参考表盘中的 `MiSans-Regular`、`misansw_demibold`；其他设备按字体文件检测选择原 Demibold 字体，加载失败回退内置字体。API 成功返回不代表字体字形正确，中文字体与粗细仍须实机核对。

![Band 9 预览](devices/band9/preview.png)
