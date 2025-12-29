# Phase 1 Testing Guide: Real-Time Infrastructure

## Overview

This guide explains how to test the Phase 1 implementation (real-time WebSocket infrastructure). You'll verify that:

1. WebSocket connections are established
2. Real-time updates work (no polling)
3. Notifications appear for events
4. All components update instantly

---

## Prerequisites

1. **Servers Running:**
   - Backend server on port 3001
   - Frontend dev server on port 3000
   - WebSocket server running on same port as backend

2. **Database:**
   - Supabase project running
   - Test session created and in `in_progress` status
   - Test users (at least 2: one trainer, one participant)

3. **Browser:**
   - Open browser DevTools (F12)
   - Network tab open
   - Console tab open

---

## Test 1: WebSocket Connection

### Steps:

1. Open frontend in browser (`http://localhost:3000`)
2. Log in as a user
3. Navigate to a session (`/sessions/:id`)

### What to Check:

**Browser Console:**

- Look for: `[WEBSOCKET] Connected`
- No connection errors

**Network Tab:**

- Filter by "WS" (WebSocket)
- Should see a WebSocket connection to `ws://localhost:3001` or `wss://localhost:3001`
- Status should be "101 Switching Protocols"
- Connection should stay open (not close immediately)

### Expected Result:

✅ WebSocket connection established and maintained

### If Failed:

- Check backend server is running on port 3001
- Check CORS configuration in `server/index.ts`
- Check authentication token is valid
- Check browser console for specific error messages

---

## Test 2: Real-Time Decision Updates

### Setup:

1. Open session in two browser windows/tabs
   - Window 1: Login as Trainer
   - Window 2: Login as Participant (different role that can approve)

### Steps:

1. **Window 1 (Trainer):**
   - Go to Decisions tab
   - Create a new decision
   - Fill in: Title, Description, Decision Type, Required Approvers (include the role from Window 2)

2. **Window 2 (Participant):**
   - Go to Decisions tab
   - **Do not refresh the page**
   - Wait 1-2 seconds

### What to Check:

**Window 2 (Participant):**

- ✅ New decision should appear **automatically** without refreshing
- ✅ Should see notification banner: "New Decision Requires Approval"
- ✅ Decision status should be "PENDING"

**Browser Console (Window 2):**

- Look for WebSocket event: `event` with `type: 'decision.proposed'`
- No polling requests (no repeated `GET /api/decisions` every 5 seconds)

**Network Tab (Window 2):**

- Filter by "Fetch/XHR"
- Should NOT see repeated `GET /api/decisions` requests every 5 seconds
- Should only see initial load request
- WebSocket messages should appear in WS connection

### Expected Result:

✅ Decision appears instantly in both windows without page refresh
✅ No polling (no repeated API calls)

---

## Test 3: Real-Time Decision Approval

### Steps:

1. **Window 2 (Participant):**
   - Click on the decision that appeared
   - Click "APPROVE" button

2. **Window 1 (Trainer):**
   - **Do not refresh**
   - Watch the Decisions tab

### What to Check:

**Window 1 (Trainer):**

- ✅ Decision status should change from "PENDING" to "APPROVED" **automatically**
- ✅ Should see notification: "Decision Approved" or similar

**Both Windows:**

- ✅ Timeline Feed (COP tab) should show new event automatically
- ✅ Event should say decision was approved

**Browser Console:**

- Look for WebSocket events: `decision.approved`
- No polling requests

### Expected Result:

✅ Decision approval updates instantly across all connected clients

---

## Test 4: Real-Time Message Updates

### Steps:

1. **Window 1:**
   - Go to Chat tab
   - Select a channel
   - Type a message and send

2. **Window 2:**
   - Go to Chat tab
   - Select the same channel
   - **Do not refresh**

### What to Check:

**Window 2:**

- ✅ Message should appear **automatically** without refreshing
- ✅ Message should appear in real-time (within 1 second)
- ✅ Should scroll to bottom automatically

**Network Tab (Window 2):**

- Should NOT see repeated `GET /api/channels/:id/messages` requests every 2 seconds
- Should only see initial load request
- WebSocket messages should appear

**Browser Console:**

- Look for WebSocket event: `message.sent`

### Expected Result:

✅ Messages appear instantly without polling

---

## Test 5: Real-Time Resource Request Updates

### Steps:

1. **Window 1:**
   - Go to Resources tab
   - Click "REQUEST_RESOURCES"
   - Fill in: Resource type, Quantity, From Agency, To Agency
   - Submit request

2. **Window 2 (Owner of "From Agency"):**
   - Go to Resources tab
   - **Do not refresh**

### What to Check:

**Window 2:**

- ✅ New resource request should appear **automatically**
- ✅ Should see notification: "Resource Request Received"
- ✅ Request should appear in "Pending Requests" section

**Network Tab:**

- Should NOT see repeated `GET /api/resources/session/:id` requests every 5 seconds

**Browser Console:**

- Look for WebSocket event: `resource.requested`

### Expected Result:

✅ Resource requests appear instantly without polling

---

## Test 6: Real-Time Inject Publishing

### Steps:

1. **Window 1 (Trainer):**
   - Go to Injects tab
   - Create a new inject (or select existing)
   - Click "PUBLISH" button
   - Select session ID

2. **Window 2 (Participant):**
   - Go to COP tab (Timeline Feed)
   - **Do not refresh**

### What to Check:

**Window 2:**

- ✅ New inject should appear in Timeline Feed **automatically**
- ✅ Should see notification banner (red if critical, yellow if high, etc.)
- ✅ Notification should show inject title and message

**Network Tab:**

- Should NOT see repeated `GET /api/events` requests every 5 seconds

**Browser Console:**

- Look for WebSocket event: `inject.published`

### Expected Result:

✅ Injects appear instantly in timeline without polling
✅ Notifications show for critical/high severity injects

---

## Test 7: Decision Execution

### Steps:

1. **Window 1:**
   - Go to Decisions tab
   - Find an approved decision
   - Click "EXECUTE" button (if UI has it, or test via API directly)

### What to Check:

**All Windows:**

- ✅ Decision status should change to "EXECUTED" automatically
- ✅ Timeline Feed should show execution event
- ✅ Should see notification: "Decision Executed"

**Browser Console:**

- Look for WebSocket event: `decision.executed`

### Expected Result:

✅ Decision execution updates instantly across all clients

---

## Test 8: Notification System

### Steps:

1. Trigger various events (decisions, resources, injects)
2. Observe notification banner behavior

### What to Check:

**Notification Banner:**

- ✅ Should appear at top of screen
- ✅ Should show correct color based on priority:
  - Critical: Red background
  - High: Orange background
  - Medium: Yellow background
  - Low: Green background
- ✅ Should show appropriate icon (🚨 for critical, ⚠️ for high, etc.)
- ✅ Should auto-dismiss after 5 seconds (unless persistent)
- ✅ Critical notifications should be persistent (not auto-dismiss)
- ✅ Should be able to close manually with [CLOSE] button

**Multiple Notifications:**

- ✅ Should show highest priority notification first
- ✅ Should queue other notifications
- ✅ Should cycle through notifications

### Expected Result:

✅ Notifications appear for relevant events with correct styling

---

## Test 9: Verify Polling is Removed

### Critical Test - This is the main goal!

### Steps:

1. Open any session tab (Decisions, Resources, Chat, COP)
2. Open Browser DevTools → Network tab
3. Filter by "Fetch/XHR"
4. Wait 10-15 seconds
5. Watch the network requests

### What to Check:

**Network Tab:**

- ❌ Should NOT see repeated requests like:
  - `GET /api/decisions/session/:id` every 5 seconds
  - `GET /api/resources/session/:id` every 5 seconds
  - `GET /api/channels/:id/messages` every 2 seconds
  - `GET /api/events?sessionId=:id` every 5 seconds
- ✅ Should only see:
  - Initial load request when component mounts
  - Manual refresh requests (if user clicks refresh)
  - WebSocket messages in WS connection (not HTTP requests)

**Before/After Comparison:**

- **Before Phase 1:** You would see repeated HTTP requests every 2-5 seconds
- **After Phase 1:** You should see only initial load + WebSocket messages

### Expected Result:

✅ **No polling** - Only WebSocket messages for real-time updates

---

## Test 10: Multiple Sessions / Room Isolation

### Steps:

1. Open Session A in Window 1
2. Open Session B in Window 2 (different session)
3. Create a decision in Session A

### What to Check:

**Window 2 (Session B):**

- ✅ Should NOT see decision from Session A
- ✅ Events from Session A should not appear in Session B

**Browser Console:**

- Check WebSocket rooms: Should be in different rooms (`session:sessionA` vs `session:sessionB`)

### Expected Result:

✅ Events are isolated per session (room-based broadcasting works)

---

## Test 11: WebSocket Reconnection

### Steps:

1. Connect to a session
2. Temporarily stop the backend server (or disconnect network)
3. Wait 5 seconds
4. Restart backend server (or reconnect network)

### What to Check:

**Browser Console:**

- ✅ Should see disconnect message: `[WEBSOCKET] Disconnected`
- ✅ Should see reconnection attempts
- ✅ Should see reconnect message: `[WEBSOCKET] Connected`

**After Reconnection:**

- ✅ Real-time updates should resume working
- ✅ Components should still update in real-time

### Expected Result:

✅ WebSocket reconnects automatically after disconnection

---

## Test 12: Component State Consistency

### Steps:

1. Open session in multiple tabs
2. Perform actions in one tab (create decision, send message, etc.)
3. Check all tabs update correctly

### What to Check:

**All Tabs:**

- ✅ State should be consistent across tabs
- ✅ No duplicate events
- ✅ No stale data
- ✅ Latest state should be displayed

### Expected Result:

✅ State remains consistent across multiple tabs/windows

---

## Troubleshooting Common Issues

### Issue: WebSocket Not Connecting

**Symptoms:**

- Console shows connection errors
- No WebSocket connection in Network tab

**Check:**

1. Backend server running on port 3001?
2. CORS configured correctly in `server/index.ts`?
3. Authentication token valid?
4. WebSocket server initialized? (Check `server/index.ts` for `initializeWebSocketService(io)`)
5. Browser console for specific error messages

---

### Issue: Events Not Updating in Real-Time

**Symptoms:**

- Changes in one window don't appear in other windows
- Still seeing polling requests

**Check:**

1. Are WebSocket events being emitted? (Check backend logs)
2. Are clients in correct rooms? (Check browser console for `join_session` events)
3. Are components using `useWebSocket` hook?
4. Check `useWebSocket` hook is enabled (`enabled: true`)
5. Check event types match between emitter and listener

---

### Issue: Notifications Not Appearing

**Symptoms:**

- Events occur but no notification banner

**Check:**

1. Is `NotificationProvider` wrapping the app? (Check `main.tsx`)
2. Is `NotificationBanner` rendered in `SessionView`?
3. Is `useWebSocket` hook calling `addNotification` in `onEvent`?
4. Check browser console for errors in notification context
5. Check session status is `in_progress` (notifications only show for active sessions)

---

### Issue: Duplicate Events / Messages

**Symptoms:**

- Same event appears multiple times
- Messages duplicated

**Check:**

1. Are multiple `useWebSocket` hooks subscribed to same events?
2. Check for duplicate event listeners
3. Verify WebSocket client is using singleton pattern
4. Check component re-renders aren't creating duplicate subscriptions

---

## Verification Checklist

Use this checklist to verify Phase 1 is working correctly:

### WebSocket Infrastructure

- [ ] WebSocket connects successfully
- [ ] Connection persists (doesn't drop immediately)
- [ ] Reconnects automatically after disconnection
- [ ] Rooms work correctly (session isolation)

### Real-Time Updates

- [ ] Decisions update instantly (no polling)
- [ ] Messages update instantly (no polling)
- [ ] Resources update instantly (no polling)
- [ ] Injects appear instantly (no polling)
- [ ] Timeline Feed updates automatically

### Polling Removal

- [ ] No repeated HTTP requests every 2-5 seconds
- [ ] Only initial load requests + WebSocket messages
- [ ] Network tab shows clean request pattern

### Notifications

- [ ] Notification banner appears for events
- [ ] Correct priority colors displayed
- [ ] Auto-dismiss works (5 seconds)
- [ ] Critical notifications persist
- [ ] Manual close works

### State Consistency

- [ ] Multiple tabs show same state
- [ ] No duplicate events
- [ ] No stale data
- [ ] Updates propagate correctly

---

## Expected Network Pattern

### ✅ CORRECT (After Phase 1):

```
[Initial Load]
GET /api/decisions/session/:id          ← Only once on mount
GET /api/resources/session/:id          ← Only once on mount
GET /api/channels/session/:id           ← Only once on mount

[WebSocket Messages]
WS → event: { type: 'decision.proposed', ... }
WS → event: { type: 'message.sent', ... }
WS → event: { type: 'resource.requested', ... }

[No Repeated Polling]
✅ No GET requests every 2-5 seconds
```

### ❌ INCORRECT (Before Phase 1):

```
[Polling Pattern]
GET /api/decisions/session/:id          ← Every 5 seconds
GET /api/decisions/session/:id          ← Every 5 seconds
GET /api/decisions/session/:id          ← Every 5 seconds
GET /api/resources/session/:id          ← Every 5 seconds
GET /api/channels/:id/messages          ← Every 2 seconds
... (repeated indefinitely)
```

---

## Performance Comparison

### Before Phase 1 (Polling):

- **Network Requests:** ~12-30 requests per minute per component
- **Bandwidth:** High (full data payload every request)
- **Latency:** 2-5 seconds (waiting for next poll)
- **Server Load:** High (constant database queries)

### After Phase 1 (WebSocket):

- **Network Requests:** 1-3 initial loads + WebSocket messages only
- **Bandwidth:** Low (only changed data sent)
- **Latency:** <100ms (instant push)
- **Server Load:** Low (events pushed only when changes occur)

---

## Success Criteria

Phase 1 is successful if:

1. ✅ All components update in real-time (no polling)
2. ✅ Notifications appear for relevant events
3. ✅ WebSocket connection is stable
4. ✅ Network requests show no polling pattern
5. ✅ Multiple clients see same updates instantly
6. ✅ No performance degradation

---

## Next Steps After Testing

If all tests pass:

- ✅ Phase 1 is complete
- ✅ Ready to proceed to Phase 2 (Incidents System)

If tests fail:

- Review error messages in browser console
- Check backend server logs
- Verify WebSocket service initialization
- Check event type names match between server and client
- Verify components are using `useWebSocket` hook correctly

---

## Quick Test Script

For quick verification, run this in browser console while on a session:

```javascript
// Check WebSocket connection
console.log('WebSocket connected:', window.websocket?.connected);

// Monitor network requests (should not see polling)
// Open Network tab → Filter "Fetch/XHR" → Watch for repeated requests

// Test notification
// Trigger an event (create decision, send message) and verify notification appears
```

---

This testing guide covers all aspects of Phase 1. Test systematically and verify each component works correctly before proceeding to Phase 2.
