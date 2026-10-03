#!/usr/bin/env node
/**
 * _root.mjs —— 工具脚本的公共根锚点
 *
 * 为什么需要它：脚本原来用 `process.cwd()` 或 `import.meta.dirname` 找数据目录，
 * 于是「必须在工作区根目录运行」「一换目录就找不到 素材全量/」这类坑一直存在。
 * 现在统一从这里取 WS（工作区根），脚本放哪、从哪运行都不影响。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工具目录本身（<工作区>/工具） */
export const TOOLS = dirname(fileURLToPath(import.meta.url));
/** 工作区根（<工作区>） */
export const WS = join(TOOLS, '..');
