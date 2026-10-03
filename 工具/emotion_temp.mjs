import { execSync } from 'child_process';
import { pickChar } from '../mcp-canon/canon-tools.mjs';

const BASE_PATH = 'D:\\Project\\bangdream-our-notes-canon';

async function getEmotionKeywords(roleName, eventDesc) {
  let char = pickChar(roleName);
  if (char.err) {
    console.error(`[emotion_temp] 角色名解析失败：${roleName}`);
    return ['calm'];
  }

  const prompt = `你是 Bang Dream! 角色情绪分析专家。
角色：${char.name}
事件描述：${eventDesc}

请只输出一个 JSON 数组，包含当前事件中角色的可能情绪关键词（中英文都行）：
["guilty", "nervous", "protective", "sad", "excited", "calm", "angry"]

只输出 JSON 数组，不要有任何其他文字。`;

  try {
    const result = execSync(
      `node -e "
const out = execSync(\`node ../mcp-canon/canon.mjs --query "${prompt.replace(/"/g, '\\"')}"\`, { encoding: 'utf8' });
console.log(out.trim());
    "`, { encoding: 'utf8' }
    ).trim();

    return JSON.parse(result);
  } catch (e) {
    console.warn(`[emotion_temp] 云端分析失败：${e.message}`);
    return ['calm'];
  }
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('用法: node emotion_temp.mjs <角色名> <事件描述>');
  process.exit(1);
}

const [roleName, eventDesc] = args;
const result = await getEmotionKeywords(roleName, eventDesc);

console.log(JSON.stringify(result, null, 2));
