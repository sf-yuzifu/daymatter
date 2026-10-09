# 第三方来源与发行许可核对

## 已核实来源

- 原始倒数日：chiyuki0325；当前项目根LICENSE为GPL-3.0-or-later。
- UI设计：无源流沙，README已保留来源链接。
- 键盘技术迁移记录：来自作者自己的sf-yuzifu/bandcomic `86ffc63`的src/pages/ime，基于NEORUAA/Vela_input_method。用户已确认bandcomic为自有项目，不列为第三方致谢；来源仓库根AGPL许可不单独作为作者自有代码复用的发行阻断。原输入法等非自有部分仍按各自许可保留署名。
- 农历表：yize/solarlunar固定提交b1d43280119a448dbf557dfdcf73fc6f7f59f422，ISC，原记录同时致谢Ajing/JJonline；2057/2097按HKO修正。腕端tools/lunar-evaluation/LICENSE、插件LICENSE-lunar保留声明。
- 插件根LICENSE为Apache-2.0；图片实现参考漫画思路，未复制LVGL量化源码。

## 待发行决定

自有bandcomic代码复用不要求作者致谢自己。来源核对任务已按维护者确认关闭，原输入法等第三方署名及许可依据保留；倒数日根许可证保持原声明，发行时附对应源码与实际第三方记录。

宿主门槛为API Level4/WASI3；具体最低AstroBox语义版本未取得，当前dist仅Level4包，真实Level2回退包尚未找到。E-15/E-23保持未关闭，不用新包伪装回退包。
