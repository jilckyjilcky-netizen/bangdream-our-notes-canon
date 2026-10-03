# 第三方来源与许可

本仓库的 **人设 skill 层**（`人设skill/`）在**目录骨架与语气设计思路**上借用了下面这个开源项目；
事实性内容（性格、语言指纹、关系称呼、禁则、台词）全部出自本库自己的统计与整理，与该项目无关。

---

## dafeiyu-persona

- **项目**：dafeiyu-persona —— DeepSeek 二创角色「大肥鱼」的人设 skill 打包
- **作者仓库**：https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona
- **借用了什么**：
  - skill 的目录骨架：`SKILL.md` + `agents/openai.yaml` + `references/{lines,lore}.md`
  - 文档结构与组织方式（frontmatter 触发词 → 角色设定 → 说话风格 → 硬性规则 → 招牌机制 → 示范对话 → 退场规则）
  - 「人设只包裹"怎么说"、不牺牲任务正确性」的设计原则
  - 各角色目录下 `SKILL.md` 末节亦逐条注明了骨架出处
- **没有借用**：该项目的角色内容、台词与梗（本仓库角色与台词均为本项目自有语料的分析产物）

### 上游许可原文（MIT）

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 按 MIT 条款要求，上述版权声明与许可全文随本仓库一并保留。
> 本仓库自身代码与文档同样以 MIT 授权（见 `LICENSE`）。
