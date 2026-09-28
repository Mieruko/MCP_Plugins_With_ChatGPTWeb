# Windows foreground coordination — 2026-09-28

## Evidence

User TestEVM report: browser E2E and persisted result passed (run `ab790fea`, 20 clicks). Native observation saw `TestEVM Windows Use Lab`, HWND `3997818`; action preflight saw Chrome, HWND `591062`. `action_sent:false` means the click was never dispatched. This is a real foreground mismatch, not evidence of a broken click implementation. It does not identify who changed foreground.

Code review found independently locked browser and Windows sessions, allowing headed browser observations, actions or job monitoring while Windows owned the desktop. This is a possible source of interference, not a demonstrated cause of the reported incident.

## Change

Adapter revision `windows-2026-09-28-focus-coordination-3` pauses headed browser UI calls while any Windows session remains registered in the same Workbench server. Calls return `COMPUTER_DESKTOP_BUSY` before upstream dispatch. An already-running browser call must finish before Windows opens; the check repeats after worker initialization. Browser observations are invalidated when Windows opens. A failed Windows Stop retains exclusion until cleanup succeeds.

Browser job monitors skip observations during Windows ownership and retain their existing deadline. Explicit job poll reports that evidence is unchanged rather than inventing a disconnect or successful result. Headless browser work is unaffected. Chrome profile/tabs remain open; after Windows closes, explicitly observe Chrome again. Dashboard exposes `desktop_paused`.

Foreground validation is retained. `COMPUTER_WINDOW_CHANGED` clears the observation and now explicitly reports `requires_new_observation:true`, `automatic_retry:false` and recovery guidance. No focus stealing, synthetic Alt/Tab, forced input or automatic replay was added.

## Recovery and retest

1. End background browser UI work; open the Windows session, then select the intended native window manually.
2. Observe and verify the title/handle before acting. Avoid switching to Chrome on the same desktop between observation and action.
3. On focus mismatch, the action is not sent. If the test protocol says stop on first error, record BLOCKED and stop that run. An explicitly started recovery run can refocus the original window, observe again and use the new labels/token. Old tokens remain invalid.
4. If the original window was replaced, close the old session and open a new one. Close the Windows session when finished to release headed Chrome UI calls.

This exclusion coordinates only this server's tools. It cannot prevent a person, another application, or another server from changing foreground. It does not make preflight and native input atomic. Native modal/secondary-window support is not established by this change.

## Verification

- `npm run test:computer`: PASS, including the new focus-coordination fixture, existing HTTP permissions, upload, session sharing, persistence and fault tests.
- `node scripts/test-computer-focus.mjs`: PASS after adding the exact title/HWND regression. Synthetic snapshots confirm zero dispatched clicks on mismatch, stale-token rejection after refocus, and exactly one explicit action following a fresh observation.
- Coordination checks use isolated headless workers with simulated Windows ownership; no real native capture or input. Queued browser observations/monitor send zero upstream calls during exclusion, headless work continues, failed Stop retains exclusion, closing Windows restores browser access.
- `node --check public/ui/computer-use.js`: PASS.
- `npm test`: PASS exit 0 after the coordination change. `npm run build` and `git diff --check`: PASS. Open/upload structured errors and paused join guidance verified through registered tool handlers in the focus fixture.

Live server was not restarted. The user's native Windows session/desktop lease was left intact. TestEVM native E2E remains BLOCKED/unverified until a new authorized run against the updated server; this report does not promote it to PASS.

## Subsequent user-reported native acceptance

The user subsequently reported a successful TestEVM Windows Use run `9019631a` on 2026-09-28, 17:57–18:12 GMT+7 (about 15m37s). Reported results: 20 individual clicks, file contents, Unicode input, checkbox, scroll to item 30, modal and secondary-window checks all passed, ending in `CU_DONE_9019631a` and JSON `status: PASS`. After closing/relaunching the application, run ID, count, description, destination and filename persisted; HWND changed from `591426` to `918282`. The Windows session was closed afterward.

This is user-provided native acceptance evidence, not a native run executed by the coding agent. It supersedes the earlier BLOCKED result for that subsequent run only. Remaining reported limitations: individual observe/action round trips, long JSON making target lists unwieldy, and an image-forwarding issue in the tool layer. Background operation without foreground ownership has not been implemented.
