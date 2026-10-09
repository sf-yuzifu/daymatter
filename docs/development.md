# 开发指南

## 环境与构建

- Node.js ≥18.18（ESLint 9要求18.18；Vela构建工具本身要求18.10）。
- Yarn 1，使用`yarn.lock`锁定依赖。
- aiot-toolkit、JSC编译器由项目依赖提供。
- 插件使用Rust1.98.0、wasm32-wasip2，工具链由插件仓库固定。

```bash
yarn install --frozen-lockfile
npm run start
npm run build
npm run release
npm run check:release
```

发布使用本地`sign/`材料，输出`dist/com.yzf.daymatter.release.2.1.rpk`。保留完整CSS属性名：手环9 Pro固件3.1.171拒绝CSS缩写，发布不要启用`--optimize-css-attr`。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/app.ux` | 初始化设备信息和应用级服务 |
| `src/components/` | 日期、排序、事件存储、背景存储、互联分发、表盘和时钟 |
| `src/pages/` | 首页、列表、编辑、日期选择、键盘和关于页 |
| `src/common/`、`src/i18n/` | 共用资源、样式和语言文件 |
| `tools/` | 工程检查、回归模拟、资源与产物分析 |
| `docs/` | 开发与接口文档 |

`node_modules/`、`build/`、`dist/`可重新生成；`sign/`需保留且不提交。开发待办和历史归档用于本地维护。

## 检查与测试

| 命令 | 范围 |
| --- | --- |
| `npm run check` | ESLint含UX脚本、版本/路由/四语言键、检查工具格式；只读 |
| `npm test` | 页面/协议、日期、存储、表盘和背景主要回归 |
| `npm run test:ime` | 键盘草稿、页面生命周期与协议模拟 |
| `npm run test:date` | 日期及重复算法 |
| `npm run test:store` | 迁移、提交、校验与失败恢复 |
| `npm run test:watchface` | 主事件与派生文件维护 |
| `node --test tools/test-background.cjs` | 索引、安全替换、分片及失败路径 |
| `npm run test:memory` | Node GC/页面资源模拟，非设备内存 |
| `npm run check:release` | 已构建RPK六页完整CSS属性检查 |

`format:check`目前只检查新增检查工具，不对全部业务源码施加格式改写。

插件仓库：

```bash
cargo test --target x86_64-pc-windows-msvc
python scripts/build_dist.py --release --package
```

插件跨语言回归需要Node和相邻`../daymatter`仓库，通过`tools/protocol-bridge.cjs`驱动实际腕端页面脚本。模拟不能替代真实宿主重入、文件系统、渲染、触控、BLE和内存验收。

## 资源与产物

```bash
npm run check:budget
node tools/optimize-png.cjs --check
npm run optimize:png
npm run analyze:size
npm run analyze:size -- --baseline tools/size-baseline.json
node tools/analyze-size.cjs --json
node tools/artifact-info.cjs
```

PNG优化验证解码RGBA一致；图片预算检查内置资源，不包括用户背景。产物分析记录体积、哈希、构建参数及公开签名证书匹配；对比时核对配置，压缩体积不等于运行内存。`artifact-info`同时读取相邻插件产物。
