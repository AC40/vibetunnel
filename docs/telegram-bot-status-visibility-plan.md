# Plan: Fix Telegram Bot - Status Visibility & Response Handling

## Problem Statement

1. **No status visibility** - User can't see what Claude is doing during processing
2. **5-minute timeout too short** - Claude can work for an hour, timeout kills it prematurely
3. **No response streaming** - Events may be coming but user sees nothing until completion
4. **No concurrent query prevention** - Multiple messages spam Claude without coordination

## Solution Overview

### 1. Remove/Extend Timeout

**File: `web/src/telegram/telegram-bot-service.ts`**

Current code has 5-minute hardcoded timeout at line 565. Options:
- Remove timeout entirely (let Claude work as long as needed)
- Increase to much longer (e.g., 2 hours)
- Make it configurable

**Change:**
```typescript
// Remove the 5-minute timeout - let Claude work as long as needed
// User can always /cancel if needed
const result = await bridge.query({...});
```

### 2. Prevent Concurrent Queries Per User

**File: `web/src/telegram/telegram-bot-service.ts`**

Add check before starting new query:
```typescript
private async forwardToClaude(ctx: Context, prompt: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Check if already processing
  const existingBridge = this.activeBridges.get(userId);
  if (existingBridge?.isRunning()) {
    await ctx.reply('⏳ Claude is already working on a previous message. Use /cancel to interrupt, or wait for it to finish.');
    return;
  }
  // ... rest of function
}
```

### 3. Add Status Updates During Processing

Send periodic status updates so user knows Claude is still working.

**File: `web/src/telegram/telegram-bot-service.ts`**

Add status update interval:
```typescript
// Send periodic "still working" updates
let statusUpdateCount = 0;
const statusInterval = setInterval(async () => {
  statusUpdateCount++;
  const tool = formatter.getCurrentTool();
  const minutes = statusUpdateCount; // 1 update per minute

  if (tool) {
    await ctx.replyWithChatAction('typing');
    // Status already shown for tool
  } else if (minutes % 2 === 0) {
    // Every 2 minutes if no tool activity
    await ctx.reply(`⏳ Claude is still working... (${minutes} min)`);
  } else {
    await ctx.replyWithChatAction('typing');
  }
}, 60_000); // Every minute

// Clear on completion
bridge.on('exit', () => clearInterval(statusInterval));
```

### 4. Add Diagnostic Logging for Event Stream

**File: `web/src/telegram/claude-sdk-bridge.ts`**

Log each event to understand what Claude is outputting:
```typescript
rl.on('line', (line) => {
  logger.debug(`[stdout] ${line.slice(0, 200)}`);
  try {
    const event = JSON.parse(line) as SDKEvent;
    logger.debug(`[event] type=${event.type}`);
    this.emit('event', event);
    // ...
  } catch (_e) {
    logger.debug(`[non-json] ${line.slice(0, 100)}`);
  }
});
```

**File: `web/src/telegram/output-formatter.ts`**

Log event handling:
```typescript
handleEvent(event: SDKEvent): TelegramAction | null {
  logger.debug(`[formatter] Received event type: ${event.type}`);
  // ... existing logic

  // Log when action is returned
  if (action) {
    logger.debug(`[formatter] Emitting action: ${action.type}`);
  }
  return action;
}
```

### 5. Ensure Buffer Flushes on Exit

**File: `web/src/telegram/output-formatter.ts`**

Make `flushBuffer()` public so it can be called from outside.

**File: `web/src/telegram/telegram-bot-service.ts`**

Flush buffer when Claude process exits:
```typescript
bridge.on('exit', (code) => {
  clearInterval(statusInterval);

  // Flush any remaining buffered text
  if (formatter.hasPendingContent()) {
    const text = formatter.forceFlush(); // New public method
    if (text) {
      ctx.reply(text);
    }
  }

  logger.log(`[forwardToClaude] Claude exited with code ${code}`);
});
```

### 6. Add `/status` Command

Show active queries and their state.

**File: `web/src/telegram/telegram-bot-service.ts`**

Track query metadata:
```typescript
interface ActiveQuery {
  userId: number;
  prompt: string;
  startTime: Date;
  currentTool: string | null;
}
private activeQueries = new Map<number, ActiveQuery>();
```

Add command handler:
```typescript
this.bot.command('status', (ctx) => this.handleStatus(ctx));

private async handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !this.isAuthorized(userId)) return;

  const query = this.activeQueries.get(userId);
  if (!query) {
    await ctx.reply('No active query. Claude is idle.');
    return;
  }

  const elapsed = Math.floor((Date.now() - query.startTime.getTime()) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const tool = query.currentTool ? `\n🔧 Using: ${query.currentTool}` : '';

  await ctx.reply(
    `📊 *Active Query*\n\n` +
    `⏱ Running: ${minutes}m ${seconds}s\n` +
    `📝 Prompt: "${query.prompt.slice(0, 50)}..."${tool}`,
    { parse_mode: 'Markdown' }
  );
}
```

Update query tracking when tool changes:
```typescript
formatter.on('action', async (action) => {
  if (action.type === 'status') {
    // Update current tool in activeQueries
    const query = this.activeQueries.get(userId);
    if (query) {
      query.currentTool = action.text.replace('🔧 Using ', '').replace('...', '');
    }
  }
  // ... rest of handler
});
```

## Files to Modify

| File | Changes |
|------|---------|
| `web/src/telegram/telegram-bot-service.ts` | Remove timeout, add concurrent check, add status updates, add `/status` command, add exit flush |
| `web/src/telegram/output-formatter.ts` | Make `flushBuffer()` public, add logging |
| `web/src/telegram/claude-sdk-bridge.ts` | Add event logging |

## Implementation Order

1. **Remove timeout** - Quick fix, lets Claude work longer
2. **Add concurrent query check** - Prevents spam
3. **Add `/status` command** - User can check query state
4. **Add diagnostic logging** - Understand what events are coming through
5. **Add periodic status updates** - User visibility during long operations
6. **Ensure buffer flush on exit** - Don't lose buffered text

## Verification

1. Send a message via Telegram
2. Check server logs for:
   - Events received from Claude
   - Event types being processed
3. Verify:
   - "Already working" message if sending second message
   - `/status` shows current query with elapsed time and tool
   - Periodic status updates during long operations
   - Response appears when Claude finishes (or when /cancel used)
