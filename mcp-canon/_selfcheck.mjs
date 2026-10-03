#!/usr/bin/env node
/** _selfcheck.mjs —— 自检辅助：确认工具层可加载并打印工具数（供 start-kb.ps1 兜底检查） */
import { tools, kb, checkOllama, EMBED_MODEL } from './canon-tools.mjs';
const up = await checkOllama();
console.log(`tools:${Object.keys(tools).length} ollama:${up} embed:${EMBED_MODEL} chars:${kb.characters.length} events:${kb.events.length} quotes:${kb.characters.reduce((a, c) => a + (c.quote_bank || []).length, 0)}`);
