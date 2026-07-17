import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(
  new URL("../skills/execute-mattpocock-spec/SKILL.md", import.meta.url),
  "utf8",
);
const adapter = await readFile(
  new URL("../skills/execute-mattpocock-spec/COMPLETION-ADAPTER.md", import.meta.url),
  "utf8",
);

test("keeps the same coordinator session alive across completed frontiers", () => {
  assert.match(
    skill,
    /进度通知只能作为 `commentary` 中间更新，不得以 `final response`、结束当前执行或等待用户继续来结束一个 Frontier/,
  );
  assert.match(
    skill,
    /写入成功的 checkpoint 后，主代理必须在同一协调会话中立即继续派发下一.*Frontier/, 
  );
});

test("Codex adapter collects a frontier before dispatching the next one", () => {
  assert.match(
    adapter,
    /Codex.*同一个主协调会话中.*等待并收集当前 Frontier 的全部原生终态.*再派发下一 Frontier/, 
  );
  assert.match(
    adapter,
    /不得把 Frontier 完成通知作为一次 Codex 执行的终点/, 
  );
});

test("records each completed local Ticket with checkboxes in an immediate checkpoint commit", () => {
  assert.match(
    skill,
    /代码提交后，主代理必须在该代码提交之后立即创建一个 checkpoint commit/,
  );
  assert.match(
    skill,
    /同一个 checkpoint commit 必须同时包含.*Issue 文件.*`state\.json`/,
  );
  assert.match(
    skill,
    /`end_commit` 记录 Completion Result 中最后一个代码 commit 的 SHA/,
  );
});
