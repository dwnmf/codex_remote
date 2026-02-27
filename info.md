# План интеграции `/ulw` (ULW / UltraWork Loop) в веб-чат

## Что уже выяснили
- В `codex-remote` slash-команды не парсятся отдельно на фронте/бэке: текст уходит как обычный `input.text`, интерпретация команды происходит во внешнем `codex app-server`.
- Значит для настоящей команды `/ulw` основная реализация должна быть в обработчике команд `app-server`, а `codex-remote` можно оставить почти без изменений.
- В `D:\REALPROJECTS\oh-my-opencode` ULW loop уже выделен как отдельная state-machine и хорошо переносится:
  - `command-arguments.ts` (парсинг аргументов),
  - `types.ts`, `loop-state-controller.ts` (состояние цикла),
  - `completion-promise-detector.ts` (детект `<promise>...</promise>`),
  - `continuation-prompt-builder.ts` (continuation prompt + `ultrawork`-режим).

## Рекомендуемая архитектура (MVP)
1. Пользователь вводит в чат:  
   `/ulw сделать ...`
2. `codex-remote` передает сообщение как есть в текущем канале (`Thread.svelte` -> relay -> anchor -> `app-server`).
3. В `app-server`:
   - распознается команда `/ulw`,
   - создается loop state, привязанный к `session/thread`,
   - после каждого `session.idle` проверяется completion promise,
   - если promise не найден, отправляется continuation prompt (в ULW-стиле),
   - цикл останавливается по `promise`/`max_iterations`/`cancel`.
4. Результаты и прогресс стримятся обратно в чат обычными событиями (предпочтительно совместимыми с уже существующими типами).

## Контракт команды `/ulw`
- Формат:
  - Основной (мобильный): `/ulw <задача>`
  - Совсем короткий: `/u <задача>` (алиас)
  - Быстрый стоп: `/u stop`
- Для MVP:
  - если задача не передана (`/ulw`), брать последний user message как задачу,
  - поддержать только `strategy=continue` (без создания новой сессии),
  - все параметры скрыты под дефолтами: `completion-promise=DONE`, `max-iterations=30`.
- Расширенный режим (не для телефона, опционально):
  - `/ulw config max=50 promise=DONE` (редко используемая настройка для power users).

## Точки интеграции в `codex-remote` (минимум изменений)
- Можно не менять transport-цепочку:  
  `src/routes/Thread.svelte`, `services/orbit/src/relay/orbit-relay-do.ts`, `services/anchor/src/index.ts`.
- Опционально для UX:
  - кнопки над полем ввода: `ULW` (вставляет `/u `) и `Stop` (вставляет `/u stop`),
  - подсказка `/u` и `/ulw` в `src/lib/components/PromptInput.svelte`,
  - визуализация прогресса loop (если вводим новый event type) в:
    - `src/lib/types.ts`,
    - `src/lib/messages.svelte.ts`,
    - `src/lib/components/MessageBlock.svelte`,
    - `src/lib/components/Tool.svelte`.

## План работ (волны)
1. **Wave 1: Порт ядра loop в `app-server`**
   - Перенести логику из `oh-my-opencode` (аргументы, state, completion detector, prompt builder).
   - Убрать TUI/FS-зависимости, хранить state в памяти процесса (или в существующем session store).
2. **Wave 2: Командный роутер**
   - Добавить парсинг короткого синтаксиса `/u`, `/ulw`, `/u stop` в обработчик slash-команд `app-server`.
   - Привязать state к `session/thread id`.
3. **Wave 3: События прогресса**
   - MVP: использовать существующие сообщения (`agentMessage`/`commandExecution`).
   - Расширение: добавить явные события `loop_started`, `iteration_progress`, `loop_completed`, `loop_stopped`.
4. **Wave 4: UI-улучшения в `codex-remote`**
   - Мобильные quick-actions: `ULW` и `Stop`.
   - Подсказки команды в поле ввода (приоритет `/u`).
   - Рендер прогресса итераций в ленте (если введены новые event types).
5. **Wave 5: Надежность и ограничения**
   - Защита от двойного старта loop в одной сессии.
   - Таймаут/abort handling.
   - Лимиты по итерациям и размеру continuation prompt.
6. **Wave 6: Тестирование**
   - Unit: parser/state/completion detector.
   - Интеграция: `/ulw` -> несколько итераций -> успешный stop.
   - Негативные кейсы: invalid args, превышение max-iterations, ручная остановка.

## Риски и как закрыть
- Риск: в `codex-remote` нет локального lifecycle-хука `session.idle`.  
  Решение: цикл должен жить там, где есть управление сессией (`app-server`), не в UI.
- Риск: разные форматы событий между `app-server` и web UI.  
  Решение: сначала использовать совместимые существующие message types, затем вводить новый тип событий.
- Риск: runaway loop (бесконечные continuation).  
  Решение: жесткий `max_iterations`, стоп-команда, автоматическая остановка при abort/error.

## Definition of Done
- `/ulw` запускает цикл в веб-чате и выполняет авто-продолжение до `completion-promise` или лимита.
- `/u stop` (и `/ulw stop`) гарантированно останавливает активный цикл.
- Прогресс итераций виден пользователю (минимум текстом в ленте).
- Покрыты тестами базовый и негативные сценарии.
