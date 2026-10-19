import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const htmlPath = process.argv[2];
assert.ok(htmlPath, 'Pass the extracted GoalFlow index.html path.');
const html = await readFile(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'GoalFlow inline script was not found.');

function createApp({ nativeBridge = false } = {}) {
  const ids = [
    'goalTitle', 'goalDeadline', 'progressBar', 'progressLabel', 'taskCount',
    'taskList', 'goalInput', 'goalDate', 'goalFormCard', 'cancelGoal',
    'saveGoal', 'editGoalBtn', 'taskForm', 'addTaskBtn', 'taskTitle',
    'taskDate', 'parentTask', 'cancelTask', 'saveTask', 'exportBtn', 'importBtn', 'importFile', 'syncNotionBtn', 'workerUrl', 'notionPassword', 'notionStatus'
  ];
  const elements = new Map(ids.map(id => [id, {
    id, hidden: false, value: '', style: {}, children: [],
    setAttribute() {}, append(...children) { this.children.push(...children); },
    focus() {}, click() { this.clickCount = (this.clickCount || 0) + 1; }
  }]));
  const anchors = [];
  const alerts = [];
  const saved = new Map();
  const bridgeCalls = { sync: [], exports: [] };
  const bridge = nativeBridge ? {
    sync(json) { bridgeCalls.sync.push(JSON.parse(json)); },
    exportBackup(json) { bridgeCalls.exports.push(JSON.parse(json)); }
  } : undefined;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        assert.ok(elements.has(id), `Unexpected DOM id: ${id}`);
        return elements.get(id);
      },
      createElement(tag) {
        const element = {
          tagName: tag, style: {}, children: [], setAttribute() {},
          append(...children) { this.children.push(...children); }, click() { this.clicked = true; }
        };
        if (tag === 'a') anchors.push(element);
        return element;
      }
    },
    localStorage: {
      getItem(key) { return saved.get(key) ?? null; },
      setItem(key, value) { saved.set(key, String(value)); }
    },
    window: { GoalFlowBridge: bridge },
    crypto: { randomUUID: (() => { let n = 0; return () => `test-id-${++n}`; })() },
    URL: { createObjectURL: () => 'blob:goalflow-test', revokeObjectURL() {} },
    Blob,
    confirm: () => true,
    alert: message => alerts.push(message),
    setTimeout: callback => { callback(); return 1; },
    console
  });
  vm.runInContext(script, context, { filename: 'goalflow-index.html' });
  return { elements, anchors, alerts, bridgeCalls, saved };
}

const importedPlan = {
  goal: 'Chuẩn bị kỳ thi',
  deadline: '2026-12-01',
  tasks: [{ id: 'task-1', title: 'Ôn chương một', date: '2026-11-01', done: true }]
};

const browser = createApp();
assert.ok(JSON.parse(browser.saved.get('goalflow_web_v1')).goalId, 'Initial stable IDs persist before a network sync can partially fail.');
const hierarchy = createApp();
const firstTaskActions = hierarchy.elements.get('taskList').children[0].children[2];
firstTaskActions.children[1].onclick();
assert.equal(hierarchy.elements.get('parentTask').value, 'test-id-2', 'New subtask is linked to the selected parent.');
hierarchy.elements.get('taskTitle').value = 'Child item';
hierarchy.elements.get('taskDate').value = '2026-11-15';
hierarchy.elements.get('saveTask').onclick();
const hierarchicalBackup = JSON.parse(hierarchy.saved.get('goalflow_web_v1'));
assert.equal(hierarchicalBackup.tasks.at(-1).parentTaskId, 'test-id-2');
assert.equal(hierarchicalBackup.tasks.at(-1).title, 'Child item');

browser.elements.get('importBtn').onclick();
assert.equal(browser.elements.get('importFile').clickCount, 1, 'Browser import should open the file input.');
await browser.elements.get('importFile').onchange({
  target: { files: [{ text: async () => JSON.stringify(importedPlan) }] }
});
const importedState = JSON.parse(browser.saved.get('goalflow_web_v1'));
assert.equal(importedState.goal, importedPlan.goal);
assert.equal(importedState.deadline, importedPlan.deadline);
assert.equal(importedState.tasks[0].title, importedPlan.tasks[0].title);
assert.ok(importedState.goalId);
assert.equal(importedState.tasks[0].goalId, importedState.goalId);
assert.equal(importedState.tasks[0].parentTaskId, '');
assert.ok(browser.alerts.includes('Đã nhập dữ liệu.'));
browser.elements.get('exportBtn').onclick();
assert.equal(browser.anchors.length, 1, 'Browser export should create a downloadable link.');
assert.equal(browser.anchors[0].download, 'goalflow-backup.json');
assert.equal(browser.anchors[0].href, 'blob:goalflow-test');

const webView = createApp({ nativeBridge: true });
webView.elements.get('exportBtn').onclick();
assert.equal(webView.bridgeCalls.exports.length, 1, 'Android export should call the native bridge.');
assert.equal(webView.bridgeCalls.exports[0].goalId, 'test-id-1');
assert.equal(webView.bridgeCalls.exports[0].tasks.length, 3);
assert.equal(webView.bridgeCalls.exports[0].tasks[0].id, 'test-id-2');
assert.equal(webView.bridgeCalls.exports[0].tasks[0].goalId, 'test-id-1');
assert.equal(webView.bridgeCalls.exports[0].tasks[0].parentTaskId, '');
assert.equal(webView.anchors.length, 0, 'Android export should not use the browser download fallback.');
await webView.elements.get('importFile').onchange({
  target: { files: [{ text: async () => JSON.stringify(importedPlan) }] }
});
assert.equal(webView.bridgeCalls.sync.at(-1).goal, importedPlan.goal);
assert.equal(webView.bridgeCalls.sync.at(-1).tasks[0].id, 'task-1');
assert.equal(webView.bridgeCalls.sync.at(-1).tasks[0].parentTaskId, '');

console.log('Backup import/export checks passed for browser and Android WebView bridge paths.');
