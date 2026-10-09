# 2.1 本地收尾交付 · 2026-10-09

## 功能与修正

- 年度重复、公历/农历、独立显示单位、排序置顶、分类归档、快捷模板/近期、独立表盘主事件及JSON备份恢复。
- 背景自动读取实际尺寸、原尺寸JPEG（单边≤512px/100KiB）、居中裁剪/黑边成品预览、3KiB逐片落盘ACK、长度/FNV校验与最终保存回执，索引提交失败保留旧图，关于页恢复默认。
- 关闭CSS缩写优化，兼容手环9 Pro固件3.1.171的完整属性名；修复预览拉伸及背景误报旧协议。
- 收尾修复早到/重复ACK、finish重复推进、原生写入期间超时隔离和首次写入ArrayBuffer回退，新增实际Rust发送器→腕端页面分片/失败往返。

## 构建与验证

应用2.1/21001，插件manifest2.1/Cargo2.1.0；保持版本未自动递增，功能通过能力协商。Node26.9.0、aiot-toolkit2.0.5、Rust1.98.0/wasm32-wasip2，JSC开启，CSS缩写关闭，签名证书已匹配嵌入产物。

- `npm run check`通过：ESLint含UX脚本、版本/路由/四语言键名、检查工具格式。
- `npm test`122/122；插件native136/136（14项实际跨语言）。
- 70张内置图资源预算通过，最大单图94.7KiB；不包含用户自定义背景，不代表真实峰值。
- 两端release/JSC/WASM/ABP构建，RPK六页完整CSS检查通过。picker selected-font-size仍有工具链提示，实际字号待设备核实。

| 产物 | 字节 | SHA-256 |
| --- | --- | --- |
| dist/com.yzf.daymatter.release.2.1.rpk | 205851（88文件） | 0aa35d3dad31effb11c77dc30a7e79e66fd13792275f9c094dd2c2f578e6d443 |
| 插件dist/daymatter_astrobox_v2_plugin.wasm | 1802980 | 34f063bc0b3bf32c65915bafccce9a800ce349d3b57ddfa836a6f3ce926d0e76 |
| 插件dist/倒数日配置工具.abp | 574649 | 32800b0eeb1a007387e3bf361462de48a3deda18ef325745ac2389f6c5fe10ff |

重建后时间戳/签名可能改变哈希。复现：`npm run release`、`npm run check:release`、`node tools/artifact-info.cjs`；插件`python scripts/build_dist.py --release --package`。

## 验收与发行保留项

1. 9 Pro新包进入列表、展开筛选、滚动/翻页及首页往返不重启；此前mm_free断言没有完整固件符号，不能由本地测试关闭。
2. 背景原尺寸/预览/上传/重进，断连重连及最终回执，关于页恢复默认；真实append/BLE/原生解码峰值和其他固件JPEG支持待测。
3. 插件输入焦点、文件选择/导出、备份合并/替换、表盘实际更新、多屏触控按功能验收；用户“很好”仅登记最新背景认可。
4. [来源许可核对](third-party-notices.md)：bandcomic为作者自有项目，不列第三方致谢；原输入法等第三方部分许可声明仍需核对。宿主最低语义版本、真实Level2回退产物未取得。

系统提醒按用户确认无推送取消；应用退出期间不保证年度表盘后台更新。无自动PNG回退或LVGL I8，分片只降低接收缓冲，JPEG像素解码内存仍需测量。
