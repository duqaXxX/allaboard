# The SDK surface the daemon depends on

Every type, function, method, option, field, key and value of `@anthropic-ai/claude-agent-sdk`
that the source under `src/agent/claude/` reads, calls or decides on, with where each is known
from. A new SDK release is checked against this table before it is pinned.

Read against `@anthropic-ai/claude-agent-sdk` 0.3.296 (bundled Claude Code 2.1.296), its
declarations in `sdk.d.ts` and the
[Agent SDK reference for TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) on
2026-10-10. The release probe found every row in 0.3.312 (bundled Claude Code 2.1.312) on
2026-10-27.

## How to read it

| Column | Meaning |
|---|---|
| Owner | For a `type` or a `function`, the module it is imported from. For anything else, the SDK type it belongs to, or a dotted path below one for what the declarations leave open (`SDKPartialAssistantMessage.event.delta`); `[]` after a name is an element of a list. A function's parameters are its own: `listSessions` owns the fields of its options, `CanUseTool` those of the options it is called with |
| Member | The name, or for a `value` the literal the code compares against or passes, in double quotes |
| Kind | `type` (an imported type or alias), `function`, `method` (of `Query`), `option` (a property the daemon passes in an object the SDK takes: `Options`, a permission result, a prompt), `field` (a property the daemon reads, below a type that `sdk.d.ts` declares), `key` (a property the daemon reads below something the declarations leave open: a stream event, a content block, a tool's result or input) or `value` |
| Used in | The files under `src/agent/claude/` and the symbols that depend on it, as `file: Class.member` |
| Source | `reference`: the reference names it, in the section of its type. `package`: `sdk.d.ts` declares it and the reference does not. `measured`: neither does, and it was read off a real stream |
| Checked by | The probe claim whose text names it, or `none` |

The source reads every record, hook input and result of Claude Code as `unknown` and narrows it
where it is read, so a row below a type is a property of the record as Claude Code writes it,
whether or not the declaration of that type has it.

A `package` or `measured` row is a dependency the documentation does not promise. It can change in
a release with no notice, so it is the first place to look when a release misbehaves.

## What keeps it true

- `test/agent/claude/sdk-surface.test.ts` runs with the test suite. It fails when the source
  imports an SDK name the table does not list or the table lists one the source no longer imports,
  when a `reference` or `package` row names something `sdk.d.ts` does not declare (the member, or
  the type it hangs from), when a `measured` row names something it does declare, when a member no
  longer appears inside any of the symbols its row names, and when a claim in the last column does
  not exist in `probe/claims.ts`. `sdk.d.ts` is read as text: a type's block runs from its
  `declare` line to the `;` that closes it, or for an interface to its closing brace, and the
  members of a union or an intersection are those of the types it names.
- The same file fails when the first list under "Types the daemon does not read" differs from
  `UNREAD_KINDS` in `translate.ts`, when a type in either list is not in the SDK's `SDKMessage`
  union or is imported by the source, when that union holds a type that is neither in the table
  nor in a list, and when a recording carries a kind listed as not recorded.
- `probe/surface.ts` reads the published reference (`readReference`) and holds the table to it and
  to the installed package (`check`, `report`); `node probe/main.ts` prints the result before its
  scenes, and `node probe/main.ts --surface` prints it alone, with no token. It reports a row as
  BROKEN when the package no longer declares it, and as UNPROVEN when a `reference` row is not
  named in the section of its type or the reference could not be read. It also lists the
  `package` and `measured` rows that no reference names and no claim covers, and the message types
  of the package that the table neither lists nor sets aside. A `reference` row is matched by
  name inside the section of its type: the match does not read what the reference says the member
  means.
- Nothing checks that the table lists every field the source reads: the import check is complete
  for types and functions only. A change that reads a new field, key or value of the SDK adds its
  row in the same pull request.

## On a new SDK release

1. Install the release and run `node --test test/agent/claude/sdk-surface.test.ts`. A failing
   test names the row.
2. For each row whose source test fails, the symbol in its Used in column is what to fix or to stop
   using. A `measured` row that the package now declares moves to `package`, or to `reference`.
3. For each type the test reports as new in the `SDKMessage` union, decide whether the daemon
   should handle it: add its rows, or list it under "Types the daemon does not read".
4. Run `node probe/main.ts --surface`. A row it reports as BROKEN is no longer in the package. A
   `reference` row it reports as UNPROVEN is no longer named in the reference: read that section
   and move the row to `package` or `measured` if the reference dropped it, or correct it if the
   reference renamed it. When it reports the reference could not be read, read the sections of
   the `reference` rows by hand.
5. Run `test/agent/claude/translate.test.ts` on the recordings: it fails on a recorded kind that
   the translator neither reads nor lists.
6. Update the versions and the date at the top of this file.

## The table

| Owner | Member | Kind | Used in | Source | Checked by |
|---|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `CanUseTool` | type | requests.ts: CallContext | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `EffortLevel` | type | session.ts: QueryHandle, effortOf | package | none |
| `@anthropic-ai/claude-agent-sdk` | `HookCallback` | type | session.ts: ClaudeSession.#hook | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `Options` | type | session.ts: QueryFunction, ClaudeSession.#options | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `PermissionMode` | type | session.ts: QueryHandle, modeOf | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `PermissionResult` | type | requests.ts: permissionResult, questionResult | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `SDKSessionInfo` | type | info.ts: listedSession | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `SDKUserMessage` | type | prompt.ts: Content, userMessage; session.ts: QueryFunction, ClaudeSession | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `SessionStore` | type | goals.ts: goalStore | package | P33 |
| `@anthropic-ai/claude-agent-sdk` | `RewindFilesResult` | type | rewind.ts: filesRestore; session.ts: QueryHandle | reference | P44 |
| `@anthropic-ai/claude-agent-sdk` | `SessionMessage` | type | turns.ts: turnsOf | package | none |
| `@anthropic-ai/claude-agent-sdk` | `forkSession` | function | backend.ts: ClaudeBackend.forkSession | reference | P43 |
| `@anthropic-ai/claude-agent-sdk` | `getSessionInfo` | function | backend.ts: ClaudeBackend.sessionTitle | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `getSessionMessages` | function | turns.ts: turnsAfter | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `listSessions` | function | listing.ts: directorySessions | reference | P6 |
| `@anthropic-ai/claude-agent-sdk` | `query` | function | session.ts: ClaudeSession.constructor | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `resolveSettings` | function | advisor.ts: advisorModel | reference | none |
| `@anthropic-ai/claude-agent-sdk` | `tagSession` | function | backend.ts: ClaudeBackend.tagSession | reference | P31 |
| `Query` | `applyFlagSettings` | method | session.ts: ClaudeSession.setEffort | reference | none |
| `Query` | `close` | method | session.ts: ClaudeSession.#pump, ClaudeSession.close | reference | none |
| `Query` | `getContextUsage` | method | session.ts: ClaudeSession.contextUsage | reference | P2 |
| `Query` | `initializationResult` | method | session.ts: ClaudeSession.ready, ClaudeSession.info | reference | P2 |
| `Query` | `interrupt` | method | session.ts: ClaudeSession.interrupt | reference | P8 |
| `Query` | `rewindFiles` | method | session.ts: ClaudeSession.restoreFiles | reference | P44 |
| `Query` | `setPermissionMode` | method | session.ts: ClaudeSession.setPermissionMode | reference | P9 |
| `Query` | `stopTask` | method | session.ts: ClaudeSession.stopTask | reference | P12 |
| `HookCallbackMatcher` | `hooks` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `allowDangerouslySkipPermissions` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `canUseTool` | option | session.ts: ClaudeSession.#options | reference | P11 |
| `Options` | `cwd` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `effort` | option | session.ts: ClaudeSession.#options | reference | P16 |
| `Options` | `enableFileCheckpointing` | option | session.ts: ClaudeSession.#options | reference | P44 |
| `Options` | `env` | option | session.ts: ClaudeSession.#options, sessionEnvironment | reference | none |
| `env` | `CLAUDE_CODE_RESUME_SOURCE_ALIVE` | key | session.ts: forkSource | measured | P43 |
| `Options` | `extraArgs` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `hooks` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `includePartialMessages` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `model` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `resume` | option | session.ts: ClaudeSession.#options | reference | P7 |
| `Options` | `resumeSessionAt` | option | session.ts: ClaudeSession.#options | reference | P45 |
| `Options` | `resumeDropsTurn` | option | session.ts: ClaudeSession.#options | package | P45 |
| `Options` | `settingSources` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `stderr` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `systemPrompt` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `toolConfig` | option | session.ts: ClaudeSession.#options | reference | none |
| `Options` | `sessionStore` | option | session.ts: ClaudeSession.#options | package | P33 |
| `Options` | `sessionStoreFlush` | option | session.ts: ClaudeSession.#options | package | P33 |
| `Options.sessionStoreFlush` | `"eager"` | value | session.ts: ClaudeSession.#options | package | P33 |
| `SessionStore` | `append` | option | goals.ts: goalStore | package | P33 |
| `SessionStore` | `load` | option | goals.ts: goalStore | package | P7 |
| `ToolConfig` | `askUserQuestion` | option | session.ts: TOOL_CONFIG | reference | none |
| `ToolConfig.askUserQuestion` | `previewFormat` | option | session.ts: TOOL_CONFIG | package | none |
| `ToolConfig.askUserQuestion.previewFormat` | `"markdown"` | value | session.ts: TOOL_CONFIG | package | none |
| `PermissionResult` | `behavior` | option | requests.ts: permissionResult, questionResult | reference | none |
| `PermissionResult` | `message` | option | requests.ts: permissionResult, questionResult | reference | none |
| `PermissionResult` | `updatedInput` | option | requests.ts: permissionResult, questionResult | reference | none |
| `SDKUserMessage` | `message` | option | prompt.ts: userMessage | reference | none |
| `SDKUserMessage` | `parent_tool_use_id` | option | prompt.ts: userMessage | reference | none |
| `SDKUserMessage` | `type` | option | prompt.ts: userMessage | reference | none |
| `SDKUserMessage` | `uuid` | option | prompt.ts: userMessage | reference | P19 |
| `SDKUserMessage.message` | `content` | option | prompt.ts: contentOf, userMessage | measured | none |
| `SDKUserMessage.message` | `role` | option | prompt.ts: userMessage | measured | none |
| `SDKUserMessage.message.content[]` | `source` | option | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[]` | `text` | option | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[]` | `type` | option | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].source` | `data` | option | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].source` | `media_type` | option | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].source` | `type` | option | prompt.ts: contentOf | measured | none |
| `Settings` | `effortLevel` | option | session.ts: ClaudeSession.setEffort | package | none |
| `ResolvedSettings` | `effective` | field | advisor.ts: advisorModel | reference | none |
| `Settings` | `advisorModel` | field | advisor.ts: advisorModel | package | none |
| `Settings` | `env` | field | advisor.ts: advisorModel | package | none |
| `forkSession` | `dir` | option | backend.ts: ClaudeBackend.forkSession | reference | none |
| `forkSession` | `title` | option | backend.ts: ClaudeBackend.forkSession | reference | none |
| `forkSession` | `CLAUDE_CONFIG_DIR` | option | module.ts: claudeAgent | measured | none |
| `ForkSessionResult` | `sessionId` | field | backend.ts: ClaudeBackend.forkSession | package | P43 |
| `Query.rewindFiles` | `dryRun` | key | session.ts: ClaudeSession.restoreFiles | measured | P44 |
| `RewindFilesResult` | `canRewind` | field | rewind.ts: filesRestore | reference | P44 |
| `RewindFilesResult` | `error` | field | rewind.ts: filesRestore | reference | P44 |
| `RewindFilesResult` | `filesChanged` | field | rewind.ts: filesRestore | reference | P44 |
| `RewindFilesResult` | `insertions` | field | rewind.ts: filesRestore | reference | P44 |
| `RewindFilesResult` | `deletions` | field | rewind.ts: filesRestore | reference | P44 |
| `RewindFilesResult` | `skippedLinks` | field | rewind.ts: filesRestore | reference | P44 |
| `getSessionInfo` | `dir` | option | backend.ts: ClaudeBackend.sessionTitle | reference | none |
| `getSessionInfo` | `CLAUDE_CONFIG_DIR` | option | module.ts: claudeAgent | measured | none |
| `getSessionMessages` | `includeSystemMessages` | option | backend.ts: ClaudeBackend.#rewindStart | package | none |
| `getSessionMessages` | `dir` | option | turns.ts: turnsAfter | reference | none |
| `listSessions` | `dir` | option | listing.ts: directorySessions | reference | none |
| `listSessions` | `includeWorktrees` | option | listing.ts: directorySessions | reference | none |
| `listSessions` | `CLAUDE_CONFIG_DIR` | option | module.ts: claudeAgent | measured | P29 |
| `resolveSettings` | `cwd` | option | advisor.ts: advisorModel | reference | none |
| `resolveSettings` | `settingSources` | option | advisor.ts: advisorModel | reference | none |
| `resolveSettings` | `CLAUDE_CONFIG_DIR` | option | module.ts: claudeAgent | measured | none |
| `tagSession` | `dir` | option | backend.ts: ClaudeBackend.tagSession | reference | P31 |
| `tagSession` | `CLAUDE_CONFIG_DIR` | option | module.ts: claudeAgent | measured | P31 |
| `BaseHookInput` | `cwd` | field | hooks.ts: folderChanged | reference | P14 |
| `BaseHookInput` | `effort` | field | hooks.ts: stopHookEvents | reference | none |
| `BaseHookInput.effort` | `level` | field | hooks.ts: stopHookEvents | package | none |
| `PostModelSwitchHookInput` | `to_model` | field | hooks.ts: postModelSwitchHookEvents | reference | P26 |
| `SessionCronSummary` | `id` | field | hooks.ts: scheduledJob | package | none |
| `SessionCronSummary` | `prompt` | field | hooks.ts: scheduledJob | package | none |
| `SessionCronSummary` | `recurring` | field | hooks.ts: scheduledJob | package | none |
| `SessionCronSummary` | `schedule` | field | hooks.ts: scheduledJob | package | none |
| `StopHookInput` | `session_crons` | field | hooks.ts: scheduledJobs | package | none |
| `CanUseTool` | `description` | field | requests.ts: toRequest, CallContext | package | none |
| `CanUseTool` | `signal` | field | session.ts: ClaudeSession.#options | package | none |
| `CanUseTool` | `title` | field | requests.ts: toRequest, CallContext | package | none |
| `CanUseTool` | `toolUseID` | field | requests.ts: toRequest, CallContext | reference | none |
| `ModelInfo` | `description` | field | info.ts: modelOf | reference | none |
| `ModelInfo` | `displayName` | field | info.ts: modelOf | reference | P17 |
| `ModelInfo` | `resolvedModel` | field | info.ts: modelOf | package | none |
| `ModelInfo` | `supportedEffortLevels` | field | info.ts: modelOf | reference | P17 |
| `ModelInfo` | `supportsEffort` | field | info.ts: modelOf | reference | none |
| `ModelInfo` | `value` | field | info.ts: modelOf | reference | P17 |
| `ModelInfo` | `"default"` | value | info.ts: modelOf | measured | none |
| `ModelUsage` | `cacheCreationInputTokens` | field | translate.ts: tokensOf | reference | none |
| `ModelUsage` | `cacheReadInputTokens` | field | translate.ts: tokensOf | reference | none |
| `ModelUsage` | `inputTokens` | field | translate.ts: tokensOf | reference | none |
| `ModelUsage` | `outputTokens` | field | translate.ts: tokensOf | reference | none |
| `SDKAssistantMessage` | `error` | field | translate.ts: assistant | reference | none |
| `SDKAssistantMessage` | `message` | field | translate.ts: assistant | reference | none |
| `SDKAssistantMessage` | `parent_tool_use_id` | field | translate.ts: parentOf | reference | none |
| `SDKCompactBoundaryMessage` | `compact_metadata` | field | translate.ts: compactBoundary | reference | none |
| `SDKCompactBoundaryMessage.compact_metadata` | `post_tokens` | field | translate.ts: compactBoundary | package | none |
| `SDKCompactBoundaryMessage.compact_metadata` | `pre_tokens` | field | translate.ts: compactBoundary | package | none |
| `SDKControlGetContextUsageResponse` | `memoryFiles` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse` | `model` | field | info.ts: contextUsage | reference | none |
| `SDKControlGetContextUsageResponse` | `percentage` | field | info.ts: contextUsage | reference | none |
| `SDKControlGetContextUsageResponse` | `skills` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.memoryFiles[]` | `path` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.memoryFiles[]` | `tokens` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.skills` | `skillFrontmatter` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.skills.skillFrontmatter[]` | `name` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.skills.skillFrontmatter[]` | `source` | field | info.ts: loadedContext | package | none |
| `SDKControlGetContextUsageResponse.skills.skillFrontmatter[]` | `tokens` | field | info.ts: loadedContext | package | none |
| `SDKControlInitializeResponse` | `account` | field | info.ts: agentInfo | package | none |
| `SDKControlInitializeResponse` | `commands` | field | info.ts: agentInfo | reference | none |
| `SDKControlInitializeResponse` | `current_permission_mode` | field | info.ts: agentInfo | measured | none |
| `SDKControlInitializeResponse` | `models` | field | info.ts: agentInfo | reference | P17 |
| `SDKControlInitializeResponse.account` | `email` | field | info.ts: accountOf | package | none |
| `SDKControlInitializeResponse.account` | `subscriptionType` | field | info.ts: accountOf | package | none |
| `SDKMessage` | `subtype` | field | translate.ts: kindOf | package | none |
| `SDKMessage` | `type` | field | translate.ts: kindOf | package | none |
| `SDKMessageOrigin` | `kind` | field | translate.ts: result, user | reference | none |
| `SDKMessageOrigin` | `body` | field | translate.ts: user | package | none |
| `SDKMessageOrigin` | `runId` | field | translate.ts: user | package | none |
| `SDKMessageOrigin` | `senderTaskId` | field | translate.ts: user | reference | none |
| `SDKModelRefusalFallbackMessage` | `api_refusal_category` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage` | `content` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage` | `fallback_model` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage` | `original_model` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage` | `retracted_message_uuids` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage` | `scope` | field | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalNoFallbackMessage` | `api_refusal_category` | field | translate.ts: refusalNoFallback | package | none |
| `SDKModelRefusalNoFallbackMessage` | `content` | field | translate.ts: refusalNoFallback | package | none |
| `SDKModelRefusalNoFallbackMessage` | `original_model` | field | translate.ts: refusalNoFallback | package | none |
| `SDKPartialAssistantMessage` | `event` | field | translate.ts: kindOf, messageStart, contentBlockStart, contentBlockDelta | reference | none |
| `SDKPartialAssistantMessage` | `parent_tool_use_id` | field | translate.ts: parentOf | reference | none |
| `SDKResultMessage` | `is_error` | field | translate.ts: endingOf; session.ts: ClaudeSession.#pump | reference | none |
| `SDKResultMessage` | `local_command` | field | translate.ts: effortChanged | package | P26 |
| `SDKResultMessage` | `modelUsage` | field | translate.ts: result | reference | none |
| `SDKResultMessage` | `num_turns` | field | translate.ts: result | reference | none |
| `SDKResultMessage` | `origin` | field | translate.ts: result | reference | P25 |
| `SDKResultMessage` | `result` | field | translate.ts: result, effortChanged | reference | none |
| `SDKResultMessage` | `session_id` | field | translate.ts: result | reference | P3 |
| `SDKResultMessage` | `terminal_reason` | field | translate.ts: endingOf | reference | none |
| `SDKSessionInfo` | `customTitle` | field | info.ts: listedSession; backend.ts: ClaudeBackend.sessionTitle | reference | P32 |
| `SDKSessionInfo` | `fileSize` | field | info.ts: listedSession | reference | none |
| `SDKSessionInfo` | `gitBranch` | field | info.ts: listedSession | reference | none |
| `SDKSessionInfo` | `lastModified` | field | info.ts: listedSession | reference | none |
| `SDKSessionInfo` | `sessionId` | field | info.ts: listedSession | reference | none |
| `SDKSessionInfo` | `summary` | field | info.ts: listedSession | reference | none |
| `SDKSessionStateChangedMessage` | `state` | field | translate.ts: sessionState | package | none |
| `SDKStatusMessage` | `compact_result` | field | translate.ts: status | package | none |
| `SDKStatusMessage` | `permissionMode` | field | translate.ts: status | reference | none |
| `SDKStatusMessage` | `status` | field | translate.ts: status | reference | P22 |
| `SDKSystemMessage` | `claude_code_version` | field | translate.ts: init | reference | P1 |
| `SDKSystemMessage` | `session_id` | field | translate.ts: init | reference | none |
| `SDKTaskNotificationMessage` | `status` | field | translate.ts: taskNotification | reference | none |
| `SDKTaskNotificationMessage` | `summary` | field | translate.ts: taskNotification | reference | none |
| `SDKTaskNotificationMessage` | `task_id` | field | translate.ts: taskNotification | reference | none |
| `SDKTaskNotificationMessage` | `tool_use_id` | field | translate.ts: taskNotification | reference | none |
| `SDKTaskNotificationMessage` | `handback_report` | field | translate.ts: taskNotification | measured | none |
| `SDKTaskNotificationMessage.handback_report` | `text` | field | translate.ts: taskNotification | measured | none |
| `SDKTaskNotificationMessage` | `usage` | field | translate.ts: taskNotification | reference | none |
| `SDKTaskNotificationMessage.usage` | `duration_ms` | field | translate.ts: taskNotification | package | none |
| `SDKTaskProgressMessage` | `description` | field | translate.ts: taskProgress | reference | none |
| `SDKTaskProgressMessage` | `task_id` | field | translate.ts: taskProgress | reference | none |
| `SDKTaskProgressMessage` | `tool_use_id` | field | translate.ts: taskProgress | reference | none |
| `SDKTaskStartedMessage` | `description` | field | translate.ts: taskStarted | reference | none |
| `SDKTaskStartedMessage` | `is_backgrounded` | field | translate.ts: taskStarted | reference | none |
| `SDKTaskStartedMessage` | `parent_task_id` | field | translate.ts: taskStarted | package | none |
| `SDKTaskStartedMessage` | `run_id` | field | translate.ts: taskStarted | package | none |
| `SDKTaskStartedMessage` | `subagent_type` | field | translate.ts: taskStarted | package | none |
| `SDKTaskStartedMessage` | `task_id` | field | translate.ts: taskStarted | reference | none |
| `SDKTaskStartedMessage` | `task_type` | field | translate.ts: taskStarted | reference | none |
| `SDKTaskStartedMessage` | `tool_use_id` | field | translate.ts: taskStarted | reference | none |
| `SDKTaskUpdatedMessage` | `patch` | field | translate.ts: taskUpdated | reference | none |
| `SDKTaskUpdatedMessage` | `task_id` | field | translate.ts: taskUpdated | reference | none |
| `SDKTaskUpdatedMessage.patch` | `status` | field | translate.ts: taskUpdated | package | none |
| `SDKUserMessage` | `message` | field | translate.ts: user | reference | none |
| `SDKUserMessage` | `origin` | field | translate.ts: user | reference | P25 |
| `SDKUserMessage` | `parent_tool_use_id` | field | translate.ts: parentOf | reference | none |
| `SDKUserMessage` | `tool_use_result` | field | translate.ts: user | reference | P13 |
| `SDKUserMessageReplay` | `uuid` | field | translate.ts: user | reference | P19 |
| `SlashCommand` | `aliases` | field | info.ts: commandOf | reference | none |
| `SlashCommand` | `argumentHint` | field | info.ts: commandOf | reference | none |
| `SlashCommand` | `description` | field | info.ts: commandOf | reference | none |
| `SlashCommand` | `name` | field | info.ts: commandOf | reference | none |
| `AskUserQuestion.input` | `annotations` | option | requests.ts: questionResult | measured | none |
| `AskUserQuestion.input` | `answers` | key | requests.ts: questionResult | measured | none |
| `AskUserQuestion.input` | `questions` | key | requests.ts: questionsOf, questionResult | measured | none |
| `AskUserQuestion.input.annotations.<question>` | `notes` | option | requests.ts: annotationsOf | measured | none |
| `AskUserQuestion.input.annotations.<question>` | `preview` | option | requests.ts: annotationsOf | measured | none |
| `AskUserQuestion.input.questions[]` | `header` | key | requests.ts: questionOf | measured | none |
| `AskUserQuestion.input.questions[]` | `multiSelect` | key | requests.ts: questionOf | measured | none |
| `AskUserQuestion.input.questions[]` | `options` | key | requests.ts: questionOf | measured | none |
| `AskUserQuestion.input.questions[]` | `question` | key | requests.ts: questionOf | measured | none |
| `AskUserQuestion.input.questions[].options[]` | `description` | key | requests.ts: optionOf | measured | none |
| `AskUserQuestion.input.questions[].options[]` | `label` | key | requests.ts: optionOf | measured | none |
| `AskUserQuestion.input.questions[].options[]` | `preview` | key | requests.ts: optionOf | measured | none |
| `Options.extraArgs` | `chrome` | key | session.ts: ClaudeSession.#options | measured | none |
| `Options.extraArgs` | `replay-user-messages` | key | session.ts: ClaudeSession.#options | measured | P19 |
| `SDKAssistantMessage.message` | `content` | key | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message` | `id` | key | translate.ts: assistant | measured | P20 |
| `SDKAssistantMessage.message` | `model` | key | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.content[]` | `content` | key | translate.ts: callEnded | measured | none |
| `SDKAssistantMessage.message.content[]` | `id` | key | translate.ts: callStarted | measured | none |
| `SDKAssistantMessage.message.content[]` | `input` | key | translate.ts: callStarted | measured | none |
| `SDKAssistantMessage.message.content[]` | `is_error` | key | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.content[]` | `name` | key | translate.ts: callStarted | measured | none |
| `SDKAssistantMessage.message.content[]` | `text` | key | translate.ts: wordsOf | measured | none |
| `SDKAssistantMessage.message.content[]` | `tool_use_id` | key | translate.ts: callEnded | measured | none |
| `SDKAssistantMessage.message.content[]` | `type` | key | translate.ts: assistant, wordsOf | measured | none |
| `SDKAssistantMessage.message.content[].content` | `text` | key | translate.ts: resultText | measured | none |
| `SDKAssistantMessage.message.content[].content` | `type` | key | translate.ts: resultText | measured | none |
| `SDKPartialAssistantMessage.event` | `content_block` | key | translate.ts: contentBlockStart | measured | none |
| `SDKPartialAssistantMessage.event` | `delta` | key | translate.ts: contentBlockDelta | measured | none |
| `SDKPartialAssistantMessage.event` | `message` | key | translate.ts: messageStart | measured | none |
| `SDKPartialAssistantMessage.event` | `type` | key | translate.ts: kindOf | measured | none |
| `SDKPartialAssistantMessage.event.content_block` | `type` | key | translate.ts: contentBlockStart | measured | none |
| `SDKPartialAssistantMessage.event.delta` | `text` | key | translate.ts: contentBlockDelta | measured | none |
| `SDKPartialAssistantMessage.event.delta` | `type` | key | translate.ts: contentBlockDelta | measured | none |
| `SDKPartialAssistantMessage.event.message` | `id` | key | translate.ts: messageStart | measured | P20 |
| `SDKUserMessage.message` | `content` | key | translate.ts: user | measured | none |
| `SDKUserMessage.message.content[]` | `content` | key | translate.ts: callEnded | measured | none |
| `SDKUserMessage.message.content[]` | `id` | key | translate.ts: callStarted | measured | none |
| `SDKUserMessage.message.content[]` | `input` | key | translate.ts: callStarted | measured | none |
| `SDKUserMessage.message.content[]` | `is_error` | key | translate.ts: user | measured | none |
| `SDKUserMessage.message.content[]` | `name` | key | translate.ts: callStarted | measured | none |
| `SDKUserMessage.message.content[]` | `tool_use_id` | key | translate.ts: callEnded | measured | none |
| `SDKUserMessage.message.content[]` | `type` | key | translate.ts: user | measured | none |
| `SDKUserMessage.message.content[].content` | `text` | key | translate.ts: resultText | measured | none |
| `SDKUserMessage.message.content[].content` | `type` | key | translate.ts: resultText | measured | none |
| `SDKUserMessage.tool_use_result` | `content` | key | translate.ts: fileChange | measured | none |
| `SDKUserMessage.tool_use_result` | `filePath` | key | translate.ts: fileChange | measured | none |
| `SDKUserMessage.tool_use_result` | `resolvedModel` | key | translate.ts: agentModel | measured | none |
| `SDKUserMessage.tool_use_result` | `structuredPatch` | key | translate.ts: fileChange | measured | none |
| `SDKUserMessage.tool_use_result` | `type` | key | translate.ts: fileChange | measured | none |
| `SDKUserMessage.tool_use_result.structuredPatch[]` | `lines` | key | translate.ts: hunkOf | measured | none |
| `SDKUserMessage.tool_use_result.structuredPatch[]` | `newStart` | key | translate.ts: hunkOf | measured | none |
| `SDKUserMessage.tool_use_result.structuredPatch[]` | `oldStart` | key | translate.ts: hunkOf | measured | none |
| `SessionKey` | `subpath` | field | goals.ts: goalStore | package | none |
| `SessionMessage` | `type` | field | turns.ts: turnsOf | package | none |
| `SessionMessage` | `uuid` | field | turns.ts: turnsAfter | package | none |
| `SessionMessage` | `message` | field | turns.ts: promptOf | package | none |
| `SessionMessage.message` | `content` | key | turns.ts: promptOf | measured | none |
| `SessionMessage.message.content` | `"[Request interrupted by user"` | value | turns.ts: INTERRUPTED | measured | none |
| `SessionStoreEntry` | `type` | field | goals.ts: goalChange | package | P33 |
| `SessionStoreEntry` | `uuid` | field | goals.ts: savedMessage | package | none |
| `SessionStoreEntry` | `timestamp` | field | goals.ts: savedMessage | package | none |
| `SessionStoreEntry.type` | `"user"` | value | goals.ts: savedMessage | measured | none |
| `SessionStoreEntry.type` | `"assistant"` | value | goals.ts: savedMessage | measured | none |
| `SessionStoreEntry.type` | `"attachment"` | value | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry` | `attachment` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `type` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment.type` | `"goal_status"` | value | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `condition` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `met` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `sentinel` | key | goals.ts: goalChange | measured | none |
| `SessionStoreEntry.attachment` | `iterations` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `durationMs` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.attachment` | `tokens` | key | goals.ts: goalChange | measured | P33 |
| `SessionStoreEntry.type` | `"system"` | value | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `subtype` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry.subtype` | `"stop_hook_summary"` | value | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `hookCount` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `hookErrors` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `hookInfos` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `hookAdditionalContext` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `preventedContinuation` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry` | `stopReason` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry.hookInfos[]` | `command` | key | goals.ts: stopHookSummary | measured | P42 |
| `SessionStoreEntry.hookInfos[].command` | `"callback"` | value | goals.ts: stopHookSummary | measured | P42 |
| `command_lifecycle` | `command_uuid` | key | session.ts: ClaudeSession.#readCommand | measured | P28 |
| `command_lifecycle` | `state` | key | session.ts: ClaudeSession.#readCommand | measured | P28 |
| `command_lifecycle` | `type` | key | session.ts: ClaudeSession.#readCommand | measured | P28 |
| `CanUseTool.toolName` | `"AskUserQuestion"` | value | requests.ts: QUESTION_TOOL | measured | none |
| `EffortLevel` | `"high"` | value | capabilities.ts: CAPABILITIES | package | none |
| `EffortLevel` | `"low"` | value | capabilities.ts: CAPABILITIES | package | none |
| `EffortLevel` | `"max"` | value | capabilities.ts: CAPABILITIES | package | none |
| `EffortLevel` | `"medium"` | value | capabilities.ts: CAPABILITIES | package | none |
| `EffortLevel` | `"xhigh"` | value | capabilities.ts: CAPABILITIES | package | none |
| `HookEvent` | `"PostModelSwitch"` | value | session.ts: ClaudeSession.#options | reference | P26 |
| `HookEvent` | `"PostToolUse"` | value | session.ts: ClaudeSession.#options | reference | none |
| `HookEvent` | `"Stop"` | value | session.ts: ClaudeSession.#options | reference | none |
| `PermissionMode` | `"acceptEdits"` | value | session.ts: PERMISSION_MODES | reference | none |
| `PermissionMode` | `"auto"` | value | capabilities.ts: CAPABILITIES; session.ts: PERMISSION_MODES | reference | none |
| `PermissionMode` | `"bypassPermissions"` | value | capabilities.ts: CAPABILITIES; session.ts: PERMISSION_MODES | reference | none |
| `PermissionMode` | `"default"` | value | capabilities.ts: CAPABILITIES; session.ts: PERMISSION_MODES | reference | none |
| `PermissionMode` | `"dontAsk"` | value | session.ts: PERMISSION_MODES | reference | none |
| `PermissionMode` | `"plan"` | value | capabilities.ts: CAPABILITIES; session.ts: PERMISSION_MODES | reference | none |
| `PermissionResult.behavior` | `"allow"` | value | requests.ts: permissionResult, questionResult | reference | none |
| `PermissionResult.behavior` | `"deny"` | value | requests.ts: permissionResult, questionResult | reference | none |
| `SDKAssistantMessage.message.content[].type` | `"advisor_tool_result"` | value | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.content[].type` | `"server_tool_use"` | value | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.content[].type` | `"text"` | value | translate.ts: wordsOf | measured | none |
| `SDKAssistantMessage.message.content[].type` | `"tool_result"` | value | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.content[].type` | `"tool_use"` | value | translate.ts: assistant | measured | none |
| `SDKAssistantMessage.message.model` | `"<synthetic>"` | value | translate.ts: SYNTHETIC_MODEL, assistant | measured | none |
| `SDKAssistantMessage.type` | `"assistant"` | value | translate.ts: HANDLERS | reference | none |
| `SDKAssistantMessageError` | `"authentication_failed"` | value | translate.ts: AUTHENTICATION_FAILED, assistant | package | none |
| `SDKCompactBoundaryMessage.subtype` | `"compact_boundary"` | value | translate.ts: HANDLERS | reference | P21 |
| `SDKMessageOrigin.kind` | `"human"` | value | translate.ts: result | reference | none |
| `SDKMessageOrigin.kind` | `"peer"` | value | translate.ts: user | reference | none |
| `SDKMessageOrigin.kind` | `"task-notification"` | value | translate.ts: user | package | none |
| `SDKModelRefusalFallbackMessage.scope` | `"local"` | value | translate.ts: refusalFallback | package | none |
| `SDKModelRefusalFallbackMessage.subtype` | `"model_refusal_fallback"` | value | translate.ts: HANDLERS | package | none |
| `SDKModelRefusalNoFallbackMessage.subtype` | `"model_refusal_no_fallback"` | value | translate.ts: HANDLERS | package | none |
| `SDKPartialAssistantMessage.event.content_block.type` | `"text"` | value | translate.ts: contentBlockStart | measured | none |
| `SDKPartialAssistantMessage.event.delta.type` | `"text_delta"` | value | translate.ts: contentBlockDelta | measured | none |
| `SDKPartialAssistantMessage.event.type` | `"content_block_delta"` | value | translate.ts: HANDLERS | measured | none |
| `SDKPartialAssistantMessage.event.type` | `"content_block_start"` | value | translate.ts: HANDLERS | measured | none |
| `SDKPartialAssistantMessage.event.type` | `"message_start"` | value | translate.ts: HANDLERS | measured | P20 |
| `SDKPartialAssistantMessage.event.type` | `"message_stop"` | value | translate.ts: HANDLERS | measured | none |
| `SDKPartialAssistantMessage.type` | `"stream_event"` | value | translate.ts: kindOf | reference | none |
| `SDKRateLimitEvent.type` | `"rate_limit_event"` | value | translate.ts: HANDLERS | reference | none |
| `SDKResultMessage.local_command` | `"effort"` | value | translate.ts: effortChanged | measured | P26 |
| `SDKResultMessage.local_command` | `"model"` | value | translate.ts: effortChanged | measured | P26 |
| `SDKResultMessage.terminal_reason` | `"aborted_streaming"` | value | translate.ts: INTERRUPTED | reference | none |
| `SDKResultMessage.terminal_reason` | `"aborted_tools"` | value | translate.ts: INTERRUPTED | reference | none |
| `SDKResultMessage.type` | `"result"` | value | translate.ts: HANDLERS; session.ts: ClaudeSession.#pump, ClaudeSession.#readCommand | reference | none |
| `SDKSessionStateChangedMessage.state` | `"idle"` | value | translate.ts: AGENT_STATES | package | none |
| `SDKSessionStateChangedMessage.state` | `"requires_action"` | value | translate.ts: AGENT_STATES | package | none |
| `SDKSessionStateChangedMessage.state` | `"running"` | value | translate.ts: AGENT_STATES | package | none |
| `SDKSessionStateChangedMessage.subtype` | `"session_state_changed"` | value | translate.ts: HANDLERS | package | none |
| `SDKStatusMessage.status` | `"compacting"` | value | translate.ts: status | reference | P22 |
| `SDKStatusMessage.subtype` | `"status"` | value | translate.ts: HANDLERS | reference | none |
| `SDKSystemMessage.subtype` | `"init"` | value | translate.ts: HANDLERS | reference | P1 |
| `SDKSystemMessage.type` | `"system"` | value | translate.ts: kindOf | reference | none |
| `SDKTaskNotificationMessage.status` | `"stopped"` | value | translate.ts: taskNotification | package | none |
| `SDKTaskNotificationMessage.subtype` | `"task_notification"` | value | translate.ts: HANDLERS | reference | none |
| `SDKTaskProgressMessage.subtype` | `"task_progress"` | value | translate.ts: HANDLERS | reference | none |
| `SDKTaskStartedMessage.subtype` | `"task_started"` | value | translate.ts: HANDLERS | reference | none |
| `SDKTaskStartedMessage.task_type` | `"local_agent"` | value | translate.ts: TASK_KINDS | reference | none |
| `SDKTaskStartedMessage.task_type` | `"local_bash"` | value | translate.ts: TASK_KINDS | reference | none |
| `SDKTaskUpdatedMessage.patch.status` | `"completed"` | value | translate.ts: TERMINAL_TASK_STATUSES | package | none |
| `SDKTaskUpdatedMessage.patch.status` | `"failed"` | value | translate.ts: TERMINAL_TASK_STATUSES | package | none |
| `SDKTaskUpdatedMessage.patch.status` | `"killed"` | value | translate.ts: TERMINAL_TASK_STATUSES | package | none |
| `SDKTaskUpdatedMessage.patch.status` | `"stopped"` | value | translate.ts: TERMINAL_TASK_STATUSES | measured | none |
| `SDKTaskUpdatedMessage.subtype` | `"task_updated"` | value | translate.ts: HANDLERS | reference | none |
| `SDKUserMessage.message.content[].source.type` | `"base64"` | value | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].type` | `"image"` | value | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].type` | `"text"` | value | prompt.ts: contentOf | measured | none |
| `SDKUserMessage.message.content[].type` | `"tool_result"` | value | translate.ts: user | measured | none |
| `SDKUserMessage.message.content[].type` | `"tool_use"` | value | translate.ts: user | measured | none |
| `SDKUserMessage.message.role` | `"user"` | value | prompt.ts: userMessage | measured | none |
| `SDKUserMessage.tool_use_result.type` | `"create"` | value | translate.ts: fileChange | measured | none |
| `SDKUserMessage.type` | `"user"` | value | translate.ts: HANDLERS; prompt.ts: userMessage | reference | none |
| `command_lifecycle.state` | `"cancelled"` | value | session.ts: ClaudeSession.#readCommand | measured | none |
| `command_lifecycle.state` | `"completed"` | value | session.ts: ClaudeSession.#readCommand | measured | P28 |
| `command_lifecycle.type` | `"command_lifecycle"` | value | session.ts: ClaudeSession.#readCommand | measured | P28 |

## Types the daemon does not read

A record of a kind the translator does not match gives no event, and nothing in the reply or in
the session depends on it. The first list is `UNREAD_KINDS` in `translate.ts`: kinds that the
recordings under `test/fixtures/sdk/` carry. The second is every other type of the `SDKMessage`
union, none of which any recording carries.

### Recorded and left unread

- `command_lifecycle`: in no declaration of `sdk.d.ts`; the queue of a prompt sent while a turn runs (the translator leaves it unread; `ClaudeSession.#readCommand` reads it to end the hidden model command, rows above)
- `conversation_reset`: `SDKConversationResetMessage`
- `stream_event:content_block_stop`: a stream event of the Claude API, below `SDKPartialAssistantMessage.event`
- `stream_event:message_delta`: a stream event of the Claude API, below `SDKPartialAssistantMessage.event`
- `system:api_retry`: `SDKAPIRetryMessage`
- `system:background_tasks_changed`: `SDKBackgroundTasksChangedMessage`
- `system:hook_started`: `SDKHookStartedMessage`
- `system:notification`: `SDKNotificationMessage`
- `system:thinking_tokens`: `SDKThinkingTokensMessage`
- `tool_progress`: `SDKToolProgressMessage`

### Declared and not recorded

- `SDKAuthStatusMessage`
- `SDKCommandsChangedMessage`
- `SDKControlRequestProgressMessage`
- `SDKElicitationCompleteMessage`
- `SDKFilesPersistedEvent`
- `SDKHookProgressMessage`
- `SDKHookResponseMessage`
- `SDKInformationalMessage`
- `SDKLocalCommandOutputMessage`
- `SDKMemoryRecallMessage`
- `SDKMirrorErrorMessage`
- `SDKPermissionDeniedMessage`
- `SDKPluginInstallMessage`
- `SDKPromptSuggestionMessage`
- `SDKToolUseSummaryMessage`
- `SDKWorkerShuttingDownMessage`

## Dependencies the table cannot hold

These are not names the declarations or the reference define, so no row can express them and
no check covers them here.

- `ClaudeSession.#pump` in `session.ts` reads the `Query` as an async iterable of whatever Claude
  Code writes. The declaration is `AsyncGenerator<SDKMessage, void>`, which describes less than the
  wire carries. Measured on 2026-10-10 on the recordings under `test/fixtures/sdk/` against
  `sdk.d.ts` 0.3.296: of the 23 kinds they hold, `command_lifecycle` is in no declaration and 10
  others carry fields that the declaration of their type lacks (`thinking_display` on three stream
  events, `user_message_uuids` on `status`, `logical_parent_uuid` on `compact_boundary`, and more).
- The state `"cancelled"` is named only in comments of `sdk.d.ts` 0.3.301, never in a declaration and in no recording, so its row is `measured` only in the sense that no declaration names it. The comment of `cancel_queued` says each uuid-stamped command it cancels "is closed with a terminal 'cancelled' lifecycle", and the same comment mentions "a command_lifecycle 'cancelled' frame"; `ClaudeSession.#readCommand` ends the hidden model command on the one that names its uuid
- `ClaudeSession` names a process that ended by the start of the message of the plain `Error`
  the SDK throws, from its stream, its start or a request: `Claude Code process exited with code `,
  `Claude Code process terminated by signal ` and `Claude Code returned an error result: `. The package declares no class, field or
  value for these; the three messages are in the troubleshooting page of the SDK
  (`code.claude.com/docs/en/agent-sdk/troubleshooting`, read 2026-10-11), which says to match on
  the message. A release that words one differently gives the name `Error` again, and no check
  here says so.
- The rows under `SDKPartialAssistantMessage.event` are events of the Claude API, typed by
  `BetaRawMessageStreamEvent` of `@anthropic-ai/sdk` 0.133.0, which `sdk.d.ts` imports and does not
  declare. The same holds for the rows under `SDKAssistantMessage.message` and
  `SDKUserMessage.message` (`BetaMessage` and `MessageParam`), whose content blocks the daemon
  reads and writes. Two block types in the table, `"server_tool_use"` and `"advisor_tool_result"`,
  are declared in `@anthropic-ai/sdk` and not in this package; `advisor.jsonl` carries both
  (recorded 2026-10-28, Claude Code 2.1.312).
- The rows under `AskUserQuestion.input` describe the input of a Claude Code tool, which the SDK
  hands to `canUseTool` as a plain record. The reference lists it under Tool Input Types and the
  package declares it in `sdk-tools.d.ts`; the checks of this table read neither, so the rows stand
  on the recordings `ask.jsonl` and `ask-can-use-tool.json`. The rows of `annotations` stand on
  `sdk-tools.d.ts` 0.3.301 and on what the model received through `updatedInput` (measured
  2026-10-16): `notes` after the answer, `preview` after the selected option. `annotations` is a
  record keyed by question text, not a list: `<question>` in an owner stands for one such key.
  The daemon writes these three into the `updatedInput` of a permission result and never reads
  them, so their kind is `option`.
- `"stopped"` among the values of `SDKTaskUpdatedMessage.patch.status` is in the translator's
  `TERMINAL_TASK_STATUSES`, taken from the Python SDK's list. The declaration of `patch.status`
  lacks it and the recordings show `"completed"` and `"failed"` only.
- The rows of `SDKModelRefusalFallbackMessage` and `SDKModelRefusalNoFallbackMessage` stand on
  `sdk.d.ts` 0.3.304 and on two recordings written by hand to that shape
  (`model-refusal-fallback.jsonl`, `model-refusal-no-fallback.jsonl`), with the `content` of a
  fallback measured on Claude Code 2.1.302 (2026-10-22) and the empty `content` of a refusal
  with no fallback measured on 2.1.258. No real stream of either is recorded: the order of the
  notice among the stream's records, and the form of the uuids in `retracted_message_uuids` for
  a message of several blocks ("per-block derived uuids", `sdk.d.ts`), are unmeasured. The
  daemon reads `retracted_message_uuids` for whether it holds any, never for their values. The
  rows are `package` because the reference page was not read for them.
- `SDKMessageOrigin.body` marks a message from another of the owner's sessions only when no
  `senderTaskId` comes with it: `sdk.d.ts` 0.3.312 gives `body` to an in-process agent's message
  too, and promises `senderTaskId` only for a background subagent. The recordings hold the two
  shapes `peer-message.jsonl` and `subagent-handback.jsonl`, and no other in-process sender.
- `SDKControlInitializeResponse.current_permission_mode` is in `server-info.json` and in no
  declaration. `CanUseTool.title` is declared and was absent in both permission calls measured on
  SDK 0.3.296 on 2026-10-10. `"human"` of `SDKMessageOrigin.kind` is in no recording: the results
  of the owner's own prompts carry no `origin` there.
- `listing.ts` derives the folder of a folder's transcripts by a rule read in the package's
  `sdk.mjs` 0.3.296, which nothing documents. `test/agent/claude/listing.test.ts` writes a
  transcript where the rule puts it and has the SDK's own `listSessions` find it. `lastMessageMs`
  in `listing.ts` reads the `type` and `timestamp` of the transcript's lines, a format the
  documentation does not describe.
- `listSessions` has no option for the folder of Claude Code's records and reads
  `process.env.CLAUDE_CONFIG_DIR` in the daemon's own process (bundled `sdk.mjs` 0.3.301; neither
  `ListSessionsOptions` nor the reference mentions it). When the daemon's file sets the variable,
  `module.ts: claudeAgent` writes it into `process.env` once, at build. The row names it as an
  `option` the daemon passes, though it travels in the environment. `tagSession` reads it the
  same way (`SessionMutationOptions` has `dir` and a store, no config folder), which the scene of
  claim P31 shows by tagging a transcript that lives only under that folder. `getSessionInfo`
  finds the transcript through it as well.
- `SDKSessionInfo.customTitle` is declared as the title set with `/rename` alone. That it also holds
  the generated title is measured and not documented (the row stays `reference` because the field is
  declared, which a `measured` row may not be; claim P32 proves the behaviour on each release). Measured on
  2026-10-20 (SDK 0.3.302, Claude Code 2.1.302): it also holds the title Claude Code generates
  for a session (the transcript's `ai-title` record), and the owner's `/rename` (a `custom-title`
  record) replaces it. A generated title is there when the turn that wrote it has ended, usually
  the first, sometimes the third or a later one, and does not change afterwards. `summary` is no
  substitute: with no title it answers the session's first prompt, so `ClaudeBackend.sessionTitle`
  reads `customTitle` alone, through `getSessionInfo` alone since it runs after every turn. A `system` message `session_title_changed` exists in the stream and
  in no declaration; the daemon does not read it.
- `trust.ts: workspaceTrusted` reads `projects["<path>"].hasTrustDialogAccepted` and
  `chrome.ts: chromeEnabled` reads `claudeInChromeDefaultEnabled`, both in Claude Code's own
  `~/.claude.json`, or in `<CLAUDE_CONFIG_DIR>/.claude.json` when the daemon's file sets that
  folder. They are records of the CLI, not names of the SDK.
- `usage.ts: parseUsage` reads the wording Claude Code writes in the result of `/usage`, which the
  usage probe in `usage-probe.ts` sends as a prompt. The wording belongs to the CLI.
- The two keys under `Options.extraArgs` are flags of the CLI that the SDK forwards.
