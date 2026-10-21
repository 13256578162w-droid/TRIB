# 分流 TRIB

**只做一件事：把 Minecraft 版本装进 `.minecraft`，启动交给启动器。**

> PCL 等第三方启动器已经不再提供游戏下载功能。分流把这一步单独拆出来：
> 它只负责「下载 + 校验 + 组装」，装完之后 PCL / HMCL / 官方启动器都能直接看到并启动。

## 下载

去 [Releases](../../releases) 下载最新的 `分流-x.x.x-win-x64.zip`，解压后双击 `分流.exe`。

绿色软件：配置写在 exe 同目录的 `config.json`，不写注册表。

## 它做什么

- **下载任意版本**：从官方 CDN 或镜像拉取客户端、依赖库、资源文件，逐文件 SHA1 校验
- **安装前预检**：告诉你需要哪个 Java、要下多少、磁盘够不够、这个版本装过没有
- **装加载器**：NeoForge / Forge / Fabric，没装原版会先自动装
- **自定义实例名**：下载前就能起名，不用装完再改
- **交付给启动器**：自动识别本机的 PCL / HMCL / 官方启动器，装到它们的目录里
- **校验与修复**：已安装版本可以逐个文件核对，缺什么补什么
- **下载控制**：暂停 / 继续 / 停止，断点续传，任务栏进度

## 从源码运行

```bash
npm install
npm start
```

需要 Node 18+。国内网络建议设置镜像：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 打包

```bash
npm run build:zip
```

产物在 `dist/`。

## 公告

客户端的公告来自 `announcements.json`，通过 jsDelivr 分发：

```
https://cdn.jsdelivr.net/gh/13256578162w-droid/TRIB@main/announcements.json
```

修改这个文件并提交，客户端下次启动就会看到。格式见文件本身。

## 已知限制

- 只支持 Windows x64
- 加载器安装依赖网络能访问 maven 仓库（`maven.neoforged.net` 在部分地区被污染，此时请用镜像或代理）
- 不做启动、不做模组管理、不做整合包管理

## 说明

- 不托管任何游戏文件，所有资源均来自 Mojang 官方或公开镜像
- 不收集任何数据，没有遥测
- 仅供个人使用
