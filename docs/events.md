# Справочник событий

Документ описывает JSON-RPC методы и служебные Orbit-сообщения, которыми обмениваются web client, Orbit и Anchor.

Формат на проводе: JSON-RPC 2.0-подобные сообщения поверх WebSocket.

## Клиент -> сервер

### Управление тредами

| Метод | Параметры | Примечание |
|---|---|---|
| `thread/start` | `{ cwd, approvalPolicy?, sandbox? }` | Создать новый тред |
| `thread/list` | `{ cursor, limit }` | Постраничный список |
| `thread/resume` | `{ threadId }` | Восстановить тред вместе с историей |
| `thread/archive` | `{ threadId }` | Мягкое архивирование |

### Управление ходом (`turn`)

| Метод | Параметры | Примечание |
|---|---|---|
| `turn/start` | `{ threadId, input, collaborationMode?, model?, effort?, sandboxPolicy? }` | Запустить ход. `input` поддерживает текст и изображения |
| `turn/interrupt` | `{ threadId, turnId }` | Прервать текущий ход |

`input` пример:

```json
[
  { "type": "text", "text": "..." },
  { "type": "input_image", "image_url": "https://...", "detail": "high" }
]
```

### Collaboration mode

| Метод | Параметры | Примечание |
|---|---|---|
| `collaborationMode/list` | `{}` | Вернуть доступные режимы |

Пример передачи `collaborationMode` в `turn/start`:

```json
{
  "collaborationMode": {
    "mode": "plan",
    "settings": {
      "model": "o3",
      "reasoning_effort": "medium",
      "developer_instructions": "..."
    }
  }
}
```

Поддерживаемые режимы: `"plan"`, `"code"`.

### Ответы на запросы подтверждения

JSON-RPC response на конкретный `id`:

```json
{ "id": 123, "result": { "decision": "accept" } }
```

Варианты `decision`: `accept`, `acceptForSession`, `decline`, `cancel`.

### Ответы на запросы пользовательского ввода

```json
{ "id": 123, "result": { "answers": { "questionId": { "answers": ["..."] } } } }
```

## Anchor local helper-методы (`anchor.*`)

Эти методы обрабатываются Anchor локально и не проксируются в `codex app-server`.

| Метод | Параметры | Результат |
|---|---|---|
| `anchor.listDirs` | `{ path?, startPath? }` | `{ dirs, parent, current, roots }` |
| `anchor.git.inspect` | `{ path }` | `{ isGitRepo, repoRoot?, currentBranch? }` |
| `anchor.git.status` | `{ path }` | `{ repoRoot, branch, clean, entries[] }` |
| `anchor.git.worktree.list` | `{ repoRoot }` | `{ repoRoot, mainPath, worktrees[] }` |
| `anchor.git.worktree.create` | `{ repoRoot, baseRef?, branchName?, path?, rootDir? }` | `{ repoRoot, path, branch, head }` |
| `anchor.git.worktree.remove` | `{ repoRoot, path, force? }` | `{ removed }` |
| `anchor.git.worktree.prune` | `{ repoRoot }` | `{ prunedCount }` |
| `anchor.git.commit` | `{ repoRoot, message, stageAll?, paths? }` | `{ committed, output }` |
| `anchor.git.push` | `{ repoRoot, remote?, branch? }` | `{ pushed, output }` |
| `anchor.git.revert` | `{ repoRoot, paths? }` | `{ reverted, output }` |
| `anchor.release.inspect` | `{ ... }` | release-статус по локальному релиз-процессу |
| `anchor.release.start` | `{ ... }` | запуск локального релиз-процесса |
| `anchor.release.status` | `{ ... }` | прогресс релиза |
| `anchor.config.read` | `{ path?, anchorId? }` | `{ path, exists, content, candidates, platform }` |
| `anchor.config.write` | `{ content, path?, anchorId? }` | `{ saved, path, bytes }` |
| `anchor.image.read` | `{ path, anchorId? }` | `{ path, mimeType, dataBase64, bytes }` |
| `anchor.file.read` | `{ path, anchorId? }` | `{ path, content, bytes, truncated }` |

## Orbit control-сообщения (не JSON-RPC)

| Тип | Формат | Назначение |
|---|---|---|
| `orbit.subscribe` | `{ type, threadId }` | Подписка на события треда |
| `orbit.unsubscribe` | `{ type, threadId }` | Отписка от треда |
| `orbit.list-anchors` | `{ type }` | Запрос списка подключённых Anchor |
| `orbit.anchors` | `{ type, anchors }` | Ответ со списком устройств |
| `orbit.anchor-connected` | `{ type, anchor }` | Уведомление о новом Anchor |
| `orbit.anchor-disconnected` | `{ type, anchorId }` | Уведомление об отключении Anchor |
| `orbit.hello` | `{ type, ... }` | Приветственное сообщение при подключении |
| `ping` / `pong` | `{ type }` | Keepalive |

## Сервер -> клиент

### Жизненный цикл треда

| Метод | Параметры | Примечание |
|---|---|---|
| `thread/started` | `{ thread: ThreadInfo }` | Нотификация после `thread/start` |
| `thread/list` (response) | `{ data: ThreadInfo[] }` | Ответ RPC |
| `thread/resume` (response) | `{ thread: { id, turns: [{ items }] } }` | Полная история треда |

### Жизненный цикл хода

| Метод | Параметры | Примечание |
|---|---|---|
| `turn/started` | `{ turn: { id, status } }` | Инициализация UI состояния |
| `turn/completed` | `{ turn: { id, status } }` | Статус: `Completed`, `Interrupted`, `Failed` |
| `turn/plan/updated` | `{ turnId, explanation?, plan[] }` | Прогресс плана (`Pending/InProgress/Completed`) |
| `turn/diff/updated` | `{ threadId, turnId, diff }` | Накопительный diff workspace |

### Потоковые item-уведомления

| Метод | Параметры | Примечание |
|---|---|---|
| `item/started` | `{ item }` | Старт item |
| `item/agentMessage/delta` | `{ threadId, itemId, delta }` | Поток текста ответа ассистента |
| `item/reasoning/summaryTextDelta` | `{ threadId, delta }` | Поток краткого reasoning |
| `item/reasoning/textDelta` | `{ threadId, delta }` | Поток полного reasoning |
| `item/reasoning/summaryPartAdded` | `{ threadId }` | Разделение reasoning-блоков |
| `item/commandExecution/outputDelta` | `{ threadId, itemId, delta }` | stdout/stderr команды |
| `item/fileChange/outputDelta` | `{ threadId, itemId, delta }` | Поток file diff |
| `item/commandExecution/terminalInteraction` | `{ threadId, itemId, processId?, stdin }` | Интерактивный ввод в процесс |
| `item/mcpToolCall/progress` | `{ threadId, itemId, message }` | Прогресс MCP-вызова |
| `item/plan/delta` | `{ threadId, itemId, delta }` | Поток текста плана |
| `item/completed` | `{ item }` | Финальное состояние item |

### Запросы подтверждения от сервера

| Метод | Параметры |
|---|---|
| `item/commandExecution/requestApproval` | `{ threadId, itemId, reason? }` |
| `item/fileChange/requestApproval` | `{ threadId, itemId, reason? }` |
| `item/mcpToolCall/requestApproval` | `{ threadId, itemId, reason? }` |

### Запросы пользовательского ввода от сервера

| Метод | Параметры |
|---|---|
| `item/tool/requestUserInput` | `{ threadId, itemId, questions[] }` |

Формат вопроса:

```json
{
  "id": "...",
  "header": "...",
  "question": "...",
  "isOther": false,
  "isSecret": false,
  "options": [{ "label": "...", "description": "..." }]
}
```

## Типы `item` в `item/completed`

| Type | Payload | MessageKind |
|---|---|---|
| `userMessage` | `{ content: [{ type: "text", text }] }` | user |
| `agentMessage` | `{ text }` | assistant |
| `reasoning` | `{ summary: string[], content: string[] }` | `reasoning` |
| `commandExecution` | `{ command, aggregatedOutput, exitCode }` | `command` |
| `fileChange` | `{ changes: [{ path, diff? }] }` | `file` |
| `mcpToolCall` | `{ tool, result?, error? }` | `mcp` |
| `webSearch` | `{ query }` | `web` |
| `imageView` | `{ path?, imageUrl?, image_url?, mimeType?, mime_type?, width?, height?, bytes? }` | `image` |
| `enteredReviewMode` | `{ review }` | `review` |
| `exitedReviewMode` | `{ review }` | `review` |
| `plan` | `{ text }` | `plan` |
| `collabAgentToolCall` | `{ tool, status, receiverThreadIds, prompt }` | `collab` |
| `contextCompaction` | `{}` | `compaction` |

## Примечания по рендерингу клиента

- reasoning-дельты буферизуются и показываются как единый свернутый блок
- пустой `stdin` в `terminalInteraction` трактуется как состояние ожидания
- из `agentMessage` удаляются теги `<proposed_plan>`
- plan-item рендерится отдельной карточкой с подтверждением
- `contextCompaction` выводится как нейтральный разделитель
- режим `collaborationMode` синхронизируется с состоянием утверждения плана
