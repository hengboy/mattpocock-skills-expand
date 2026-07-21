# 运行时依赖

安装 skill 时必须一并保留 `package.json` 和 `package-lock.json`。在 skill 根目录运行：

```bash
npm run check:runtime
```

该预检会加载 schema 验证器；依赖缺失时，验证器使用锁文件执行 `npm ci --omit=dev`，随后再次加载。预检失败时，按输出在 skill 根目录手动运行：

```bash
npm ci --omit=dev
npm run check:runtime
```

不得单独安装 `ajv` 或 `ajv-formats`，也不得复制其他环境的 `node_modules`。schema 验证不可用时停止执行。
