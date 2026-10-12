# 倒数日联动表盘

面向小米 Vela 穿戴设备的 Lua 表盘，通过倒数日快应用显示主事件和自定义背景。没有主事件时显示每年 6 月 7 日的高考倒计时，当天显示今天，次日切换下一年。

## 项目结构

```text
assets/
  common/              共用 PNG 数字、冒号、卡片和今天图案
  preview-base.png     沙漏预览底版
devices/               设备专用背景、卡片和生成的预览
devices.json           设备布局与 EasyFace DeviceType
src/
  logic.lua            日期计算、事件解析、订阅值校验
  daymatter.lua        UI、字体、文件联动与刷新
tools/
  config.py            设备配置继承与共包别名解析
  build.py             生成工程并可选编译
  previews.py          生成设备预览
  test.py              Lua 5.4 回归
requirements.txt       Python 开发依赖
```

`build/` 是可重新生成的 EasyFace 工程和编译缓存，`dist/` 是最新 `.face` 安装包，两者均不纳入 Git。修改 `src/`、素材和设备配置后重新构建，不直接编辑生成工程。

设备配置统一放在 `devices.json`：布局、资源目录、背景/卡片、字体名称、预览圆角和打包尺寸。`extends` 继承父设备并覆盖指定字段（10 Pro→9 Pro，S5 41mm→S4）；`packageAlias` 指定直接复用安装包（Band 11→Band 10）。构建、预览和回归测试共用 `tools/config.py`，新增设备无需在多个脚本中添加机型分支。

## 设备与资源复用

| 构建目标 | 运行尺寸 | DeviceType | 资源 |
| --- | --- | --- | --- |
| `band9` | 192×490 | 366 | bg9、180px 专用卡片 |
| `band10` | 212×520 | 466 | bg10、通用卡片 |
| `band9pro` | 336×480 | 367 | bg9p、通用卡片 |
| `band10pro` | 336×480 | 567 | 复用 9 Pro |
| `redmiwatch6` | 432×514 | 565 | bgrw6、通用卡片 |
| `s4` | 466×466 | 462 | bgs4、通用卡片 |
| `s5_46` | 480×480 | 562 | bgs5、通用卡片 |
| `s5_41` | 466×466 | 562 | 生成时复用 S4 布局、背景和预览 |
| `band11` | 212×520 | 复用 Band 10 | 输出与 Band 10 完全相同的安装包，已实机验证 |

设备信息来自 EasyFace 内嵌枚举和屏幕信息。用户已实机验证 Band 11 共用 Band 10 包，以及 S5 41mm 使用 466×466 布局、S5 DeviceType 562 的安装兼容性；S5 41mm 继续复用 S4 资源。

## 生成与打包

需要 Python 3 和 **EasyFace 4.23**（旧 4.15 不支持部分新机型）。在仓库根目录执行：

```powershell
python -m pip install -r requirements.txt
python tools/build.py
python tools/build.py --device band9pro
python tools/build.py --compiler "<EasyFace 4.23目录>\Compiler.exe"
```

生成工程位于 `build/<目标>/daymatter.fprj`，也可用 EasyFace 手动打开。编译产物位于 `dist/daymatter-<目标>.face`，Band 11 副本名为 `daymatter-band11.face`。默认 ID 为 `252661004`，可通过 `--id` 指定。

源码在生成时内嵌成一份 Lua，不依赖额外模块加载。编译先写独立暂存目录，只有本次产物成功生成才更新 `dist/`，避免 EasyFace 返回成功退出码但未产出新包时误用旧包。

构建先校验选中设备的资源清单，再重建其 `build/<目标>/app/`，确保旧图片和模块不会混入包。素材优先从设备目录读取，再尝试共用目录；缺失素材明确报错。单设备构建只生成对应资源目录的预览，别名按实际共包目标处理。DeviceType 统一修改 `devices.json`，不再使用命令行覆盖参数。

### 预览

每次构建自动从 `assets/preview-base.png` 水平、竖直居中等比裁剪：

- 手环：胶囊形圆角，半径为宽度的一半。
- Pro：48px 圆角。
- Redmi Watch：104px 圆角。
- 圆屏：圆形。

边缘抗锯齿，外侧透明。也可单独执行 `python tools/previews.py`。S4 设备预览为 466×466，打包时缩为编译器要求的 464×464；S5 41mm 复用 S4 预览，打包时放大为 480×480，运行布局仍为 466×466。

## 快应用联动

应用包名为 `com.yzf.daymatter`，按顺序尝试以下目录：

```text
/data/quickapp/files/com.yzf.daymatter/
/data/files/com.yzf.daymatter/
```

优先接口打不开时才尝试备用目录；已打开但为空或非法时，不读取备用旧内容。创建、亮屏立即刷新，亮屏期间通过既有秒订阅约每 5 秒检查，熄屏停止文件轮询。

### 主事件

`date.txt` 格式：`名称,YYYY-MM-DD,true/false`。缺失、空文件或非法内容回退高考占位。计入起始日只影响今天和过去；超过 9999 天显示 9999 并在目标日文本说明超限。

年度和农历事件使用快应用导出的公历发生日；文件不含重复规则，快应用退出期间无法由表盘独立滚动年度发生日，需要重新打开快应用维护。

### 自定义背景

`background.txt` 保存 `bg_<数字>.png/jpg` 文件名。表盘拼接接口所在目录加载，不扫描历史图片。引用变化时更新，恢复默认时显示设备自带 PNG 背景。

图片缺失、解码失败、比布局小或超过允许尺寸时恢复默认，后续轮询重试；略大的背景保持原像素居中裁剪，例如 470×470 图片在 466×466 布局中四边各裁 2px。恢复默认同时重置图片坐标。

默认正式包不创建中央诊断框、不输出表盘调试日志。需要定位问题时使用 `--debug`：

```powershell
python tools/build.py --device band9pro --debug --compiler "<EasyFace 4.23目录>\Compiler.exe"
```

调试工程位于 `build/band9pro-debug/`，调试包为 `dist/daymatter-band9pro-debug.face`，不覆盖正式工程或包。调试模式异常时在屏幕中央显示路径和尺寸，加载成功自动隐藏诊断框；相同消息不重复打印。Band 11 调试共包使用 `daymatter-band11-debug.face`。

## 字体与手势

字体候选由 `devices.json` 的 `fonts` 配置（继承设备沿用父配置），当前统一依次尝试 `MiSans-Medium`、`MiSans-Demibold`、`misansw_demibold`。不依赖字体文件是否可见或屏幕宽度；调用报错或返回空值时尝试下一项，全部失败回退内置字体。每个字号缓存结果。若固件对未知名称静默返回默认字体，调用结果无法判断字形是否正确，仍需实机确认。

全部控件清除 `SCROLLABLE` 并开启 `EVENT_BUBBLE`，根容器额外开启 `CLICKABLE`，让系统收到长按表盘事件。

## 验证

```powershell
python tools/build.py
python tools/build.py --debug
python tools/test.py
python tools/test_build.py
```

Lua 5.4 回归覆盖八份生成入口：日期边界、高考占位、计入起始日、异常文件、双路径读取、无效订阅、数字超限、亮灭屏刷新、背景切换/重试/裁剪和对象事件标志。UI 使用模拟 API；实机还需检查字体、PNG/JPG 解码、文件访问、订阅和系统长按手势。

![Band 9 预览](devices/band9/preview.png)
