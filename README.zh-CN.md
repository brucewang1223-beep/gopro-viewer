# GoPro Viewer

你的 GoPro 早就知道你去过哪里、开得多快、刹得多狠，只是把这些都藏在 MP4 里一个没人打开的角落。这个工具负责打开它：视频、地图轨迹、画面上的 HUD 和下方的曲线共用一条时间轴；片子直接从相机走 USB 导进电脑，不用再折腾一晚上。全部在本机运行。

[English](README.md)（主文档） · 简体中文 · 设计文档 [`docs/SPEC.md`](docs/SPEC.md)（英文）

![主界面：视频、仪表、HUD、地图轨迹和曲线共用一条时间轴](docs/screenshots/viewer.jpg)

## 为什么做这个

我把 GoPro（HERO13 Black）当行车记录仪用。用了一阵，有三件事一直不顺手：

- **我和 Quik 想要的不是一回事。** 它想给我剪一段集锦，我只想看片子、看数据。
- **导到电脑上是一场仪式。** 相机插上 Mac 并不是一个 U 盘——默认的 GoPro Connect 模式下它是一块网卡。于是不是拔卡就是折腾软件，几十 GB 素材换掉一个晚上。
- **视频和地图从来没碰过面。** 这个弯在哪里、当时多快、那一脚有多狠？答案本来就在文件里（GoPro 在画面旁边写了一条 GPMF 遥测流），但我的 Mac 上没有一个工具能把两边放在一起看。

所以这个工具只做三件事，做完就收手：放片子、画数据、把片子从线上导进来。没有剪辑时间轴，不上云，不需要账号。

## 这个工具是怎么做出来的

全程是和 Claude 聊出来的——代码、测试、这份 README、以及里面的截图（Opus 5 和 Claude Fable 5.1；每次提交的 `Co-Authored-By` 都如实写着是哪个模型，这是最老实的记录）。我出需求、出意见、偶尔一票否决；它做设计、写代码、写测试，并且在提交前习惯性地在我的 Mac 上连真机核对一遍，而不是嘴上说做好了。

规矩没有停留在故事里，而是落进了仓库：103 个自动化测试、ESLint 有警告即失败、函数不超过 40 行、不留死代码。1.0 之前又完整 review 了一遍代码，顺手修掉了六十来个小毛病。

分享给同样拿 GoPro 当行车记录仪、又不想打开 Quik 的兄弟。MIT 协议，随便用、随便改，不用打招呼。

## 截图

![卫星底图叠加地名和道路标注，轨迹按速度着色](docs/screenshots/satellite.jpg)

卫星影像（Esri）叠加地名 / 道路标注，轨迹按速度着色，箭头是当前位置；下方一栏是这段录像的统计和相机设置。

![从相机导入：列出卡里的片段，导过的不再自动勾选](docs/screenshots/import.jpg)

USB 直连导入：逐条列出卡里的片段。导过的会写明哪天导到了哪里，并且不再自动勾选。

## 功能一览

- **一条时间轴。** 视频、地图、HUD、曲线跟着同一个播放位置。点地图上的轨迹、点曲线、点时间轴都能跳转，曲线上拖动可以放大（双击还原）。同一段录像的分段文件（`GX01…`、`GX02…`）自动合并，连续播放。
- **画面上的数据。** HUD 显示速度、海拔、经纬度、定位质量（2D / 3D 与 DOP）、UTC 和本地时间、当前 G 值。视频顶部有三个仪表：G 力球（加速 / 刹车 / 转弯）、陀螺球（转向率、俯仰率、横滚率）、姿态泡（俯仰与横滚）。相机歪着装、倒着装都行——"上"是从重力量出来的，不是假设的。
- **曲线。** 速度、海拔、纵向 / 横向 / 垂直 G 力、陀螺仪。速度只在定位稳定的区段绘制，接收机在搜星时反复报的那个 270 km/h 假速度上不了线。
- **地图。** OpenStreetMap 街道底图与 Esri 卫星影像（可叠加地名 / 道路标注），不需要 key、不需要账号。轨迹分已走 / 未走，可按速度着色；可以跟随当前位置，也可以一键回到全程。
- **USB 导入。** 列出卡里的内容，按录制日期分目录归档，用台账记住导过什么，导完还可以顺手清卡。详见下文。
- **导出。** GPX、GeoJSON、CSV（每个 GPS 采样点）、IMU CSV（25 Hz 加速度），另有命令行工具批量提取。
- **本机运行。** 服务只监听 `127.0.0.1`，视频和遥测数据不出这台电脑，只有地图瓦片走网络。

## 运行环境

Node.js 20 或更新（在 22 和 25 上测过），以及一个能解你片子的浏览器：H.264（`GH…` 文件）到处都能放，HEVC（`GX…` 文件）在 Safari 和 Apple Silicon 的 Chrome 上能放。放不了的时候勾上 **Proxy (LRV)**，用相机自带的低清代理文件回放——遥测数据完全一样，只是画面小一点。

## 快速开始

```bash
git clone https://github.com/brucewang1223-beep/gopro-viewer.git
cd gopro-viewer
npm install
npm start -- --media /Volumes/GOPRO/DCIM     # 换成你放 GoPro 视频的目录，可以给多个
# 打开 http://127.0.0.1:8790
```

也可以启动后在页面顶部添加目录（会存进 `config.json`），或者照着 `config.example.json` 写一个 `config.json`。全部参数：`npm start -- --help`。

手头没有素材想先看看效果：`npm run samples` 把 GoPro 官方样片下载到 `samples/`，然后 `npm start -- --media samples`。

### 开机自启与桌面应用（macOS）

```bash
npm run autostart          # launchd 代理：登录时启动，崩了自动拉起
npm run autostart:status   # 查看状态并做一次健康检查
npm run autostart:remove
```

代理在本目录下运行服务，日志写在 `.cache/server.log`。服务常驻之后，在 Chrome 里打开 http://127.0.0.1:8790 → ⋮ 菜单 → *Cast, save and share* → *Install page as app…*，就有了独立窗口和 Dock 图标（页面自带 web-app manifest 和图标，Chrome 会主动提示）。

## 从相机导入

1. 相机里 Preferences › Connections › USB Connection 选 **GoPro Connect**（出厂默认就是）。这个模式下相机不是 U 盘，而是一块小小的 USB 网卡，工具通过 Open GoPro 的 HTTP 接口和它对话。
2. 插上线，点页面顶部的 **Import from camera**。对话框列出卡里的所有片段：新的默认勾上，导过的不勾，并写明上次是哪天导到了哪里。
3. **Choose folder…** 弹出 macOS 自己的文件夹选择面板，从上次的位置开始。每个片段可以带上 **LRV** 低清代理（默认勾选，HEVC 放不了时靠它）和 **THM** 缩略图（默认不勾），两个选择都会记住。
4. **Import**。文件按录制日期放进 `<目标目录>/<YYYY-MM-DD>/`，逐个按字节校验，导完目标目录自动加入媒体库。可以关掉对话框继续看片子，状态栏会跟着进度；**Stop** 随时中断，没传完的文件留成 `.part`，下次接着传。
5. 导完会问一句：**要不要把刚导入的片段从相机上删掉**（LRV、THM 一起删）。选 *Keep on camera* 就什么都不动。只有这次完整导入的片段才会出现在删除列表里。

`import-ledger.json` 记着导过的一切，即使本地文件后来删了也不会被自动再导一遍。想重导，手动勾上即可；目标目录里那份如果还完整，会直接校验通过，不重新下载。

速度：HERO13 走 USB 2.0，实测 43 MB/s 左右，33 GB 大约 13 分钟。

对话框显示 **No camera**：相机休眠了、USB 模式设成了 MTP、或者有别的程序（MacDroid、adb 之类）占着 USB 设备。处理掉再点 **Look again**。

## 地图

默认（`"map": { "provider": "osm" }`）用 OpenStreetMap 的数据：矢量瓦片来自 [OpenFreeMap](https://openfreemap.org)（全球到 14 级，不要 key、不限量），卫星视图是 Esri World Imagery 加同一套标注叠加层，浏览器直接取瓦片。底图卡片在地图左下角，`B` 键切换；卫星视图上的 **Labels** 开关控制影像上的地名和道路标注。选择记在浏览器里，`config.json` 只决定第一次打开的默认值。

`"provider": "k2"` 把同样两套样式切到 K2 地图服务（`map.lumobility.com`，阿联酋境内细节更好），需要在 `config.json` 的 `map` 里填 token：

```json
"map": { "provider": "k2", "token": "…", "basemap": "streets", "labels": true }
```

token 只留在服务端——每个瓦片请求都由服务端签名，且 `config.json` 本身被 git 忽略。OSM 样式由 `node scripts/make-osm-styles.js` 从 K2 样式派生：改了 K2 样式重跑一次，忘了跑测试会告诉你。

## 导出

选中一段录像，控制栏的 Export：**GPX**（有定位的轨迹点，含海拔、时间、速度）、**GeoJSON**、**CSV**（每个 GPS 采样点，含定位状态和 DOP）、**IMU**（25 Hz 加速度 CSV）。GeoJSON 是一个 `FeatureCollection`，每段连续定位一条 `LineString`（丢失定位或间隔超过 5 秒就断开），海拔作为第三个坐标分量，分段统计和相机设置放在 `properties` 里，逐点的 `times` / `speeds` 放在 `properties.coordinateProperties` 里，QGIS / kepler.gl / geopandas 可以直接打开。

导出刻意不做过滤：给的是相机自己报的速度，旁边带着 `dop` 列，你按自己的分析需要去筛。

命令行批量提取（多个文件视为同一段录像的连续分段）：

```bash
node scripts/dump-telemetry.js GX010042.MP4 GX020042.MP4 --format gpx --out ride.gpx
node scripts/dump-telemetry.js GX010042.MP4 --format csv          # GPS 表，直接喂 pandas
node scripts/dump-telemetry.js GX010042.MP4 --format csv-accl     # 25 Hz 加速度
node scripts/dump-telemetry.js GX010042.MP4                       # 完整 JSON（和 API 一样）
```

## 快捷键

| 键 | 作用 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 按 Skip 步长后退 / 前进（默认 5 秒；可选 1/2/5/10 帧或 1–60 秒；按住 `Shift` ×6） |
| `,` / `.` | 上一帧 / 下一帧 |
| `[` / `]` | 上一段 / 下一段 |
| `Home` / `End` | 开头 / 结尾 |
| `M`（或 `L`） | 地图跟随当前位置 |
| `F` | 地图缩放到全程 |
| `B` | 切换底图（街道 ↔ 卫星） |
| `H` | 显示 / 隐藏 HUD |
| `G` | 显示 / 隐藏仪表 |
| 双击视频 | 全屏 |

## 已知限制

- 只在 macOS + HERO13 Black 上验证过。GPMF 遥测格式各代 GoPro 通用（`npm run samples` 下载的官方样片从 HERO5 到 MAX 都能放），其他型号回放大概率没问题，但相机导入只在 HERO13 上试过。
- 选目标目录的面板是 macOS 的。服务跑在别的系统上时，把目标目录写进 `config.json` 的 `import.dest`，其余步骤照旧。
- 侧栏里的录制时间是相机的本地时间：HERO12 以后文件头写的是真 UTC，工具会按文件头里记的时区换算回来；更老的相机文件头本来就是本地时间。鼠标悬停能看到 UTC，HUD 里两个时间都有。
- 视频始终静音：这是看数据的工具，不是播放器，音轨根本不渲染。
- 地图瓦片来自公共服务（OpenFreeMap、Esri），需要联网；其余功能离线可用。

## 常见问题

**"Cannot play / source not supported"**——浏览器解不了这个编码：HEVC 用 Safari 或 Apple Silicon 上的 Chrome，或者打开 LRV 代理（有代理文件时程序会自动切换）。**"No usable GPS fix"**——接收机从头到尾没锁上星（GPS 关着、在室内、或刚开机那几秒），视频照常播放。**改过文件后数据不对**——删掉 `.cache/`。**文件夹面板不出来**——面板是服务端在它自己那台机器上弹的，所以 `npm start` 和 launchd 代理都可以，服务跑在别的机器上就不行。

## 项目结构

```
server/   Node 服务：MP4 解析（只读 moov）、GPMF 解码、相机时钟判定、媒体库扫描、HTTP API、
          导出（GPX/GeoJSON/CSV）、K2 瓦片代理、相机导入（Open GoPro HTTP 客户端、台账、
          macOS 文件夹面板）、几何与速度规则、配置与日志
web/      浏览器界面：原生 ES 模块，没有构建步骤，自带 PWA manifest 和图标；
          styles/ 放两套 K2 MapLibre 样式和由它们派生的两套 OSM 样式
tests/    node --test 测试 + 5 秒的 GoPro 样片（见 tests/fixtures/README.md）+ 一个假相机
scripts/  命令行提取、OSM 样式派生、样片下载、macOS 开机自启
docs/     SPEC.md（设计与决策，英文）、screenshots/
.cache/   每个文件的元数据与遥测缓存（可以放心删）
```

## 开发

```bash
npm test          # 103 个测试
npm run lint      # ESLint（有警告即失败：不留死代码、函数不超过 40 行、圈复杂度不超过 12）
npm run dev       # 带 --watch 的服务
LOG_LEVEL=debug npm start -- --media <目录>
```

[`docs/SPEC.md`](docs/SPEC.md)（英文）是范围、架构、数据契约和验收标准的唯一依据：先改规格，再改代码。

本项目以英文为主语言：代码、注释、提交信息、规格文档和界面都用英文。本文件是 [`README.md`](README.md) 的中文版，以英文版为准。

## 致谢

遥测解码 [gopro-telemetry](https://github.com/JuanIrache/gopro-telemetry)（MIT），海拔校正 egm96-universal，地图渲染 MapLibre GL JS，底图数据来自 OpenStreetMap 贡献者与 OpenFreeMap，卫星影像 Esri，地图样式 K2 Maps（map.lumobility.com），曲线 uPlot。测试样片剪自 gopro/gpmf-parser 的官方公开样片（Apache-2.0）。

MIT 协议。如果你也把 GoPro 架在挡风玻璃上，希望它能帮你省下一个晚上。
