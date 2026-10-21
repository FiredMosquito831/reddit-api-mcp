# Browser Backends and Named Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows local named-account profiles, experimental own-session request replay, and Playwright UI operation behind the existing 32 Reddit tools, preserving the official API and limited RSS routes.

**Architecture:** Resolve a frozen profile/account at tool entry and dispatch validated operations to explicit capability-aware backends. Share one approval and durable write-admission boundary across all mutation routes; a lost response never causes cross-backend resubmission. A dedicated protected browser profile owns the session; browserless replay is an optional authenticated request transport, not a promise of perpetual authentication.

**Tech Stack:** JavaScript ES modules, Node.js >=22.12, existing MCP SDK 1.32.1 and zod/commander/keyring, optional Playwright with an explicitly installed browser, node:test, Windows Credential Manager/NTFS ACLs.

**Spec:** [Approved browser-backend design](../specs/2026-10-21-browser-backends-design.md). Owner approved on 2026-10-21; implementation explicitly authorized by “go implemnt.”

## Global Constraints

- First supported environment: Windows, Node.js, Claude Code, local MCP over stdio.
- All 32 existing tools are the completion target, not a claim of verified browser coverage. Partial milestones remain explicitly incomplete.
- Backend preference: official API, experimental replay, then Playwright UI; explicit choice supported. Fallback only for eligible unsupported/unavailable implementations before dispatch.
- Never change account during fallback. Explicit profile overrides saved default; freeze the selection at call entry.
- Additional application-level confirmations default to off for all 11 write tools, including deletes, in all backends. Preserve explicitly stricter settings. Host permissions remain independent.
- Visible browser by default; support headless and ask mode. Never restart a browser mid-write to change visibility.
- Playwright is required for browser backends only: explicit install/diagnostic instructions when missing, never surprise install from a tool call.
- No external model service or model SDK. Host tool observations/actions are baseline; sampling is optional and negotiated against the actual installed protocol/client.
- No borrowed client IDs, spoofing/stealth, CAPTCHA bypass, security-challenge routing, account rotation, bulk engagement, new DMs/reports/moderation tools, or harvesting everyday browser profiles.
- CAPTCHA, 2FA, security approvals and account locks have a human handoff. Do not implement a solver or retry around a challenge.
- Credentials stay outside prompts/results/logs. Named-profile secrets never come from an unrelated legacy environment. Opt-in automatic login uses locally entered OS-store credentials.
- First release's browser backends are local CLI/stdio only; preserve official API HTTP/Docker/MCPB behavior.
- No live account discovery, reads or writes are authorized by design approval. Task 16 requires separately scoped authorization.
- No commit or push unless the owner asks. Each task ends in a reviewed, testable diff checkpoint instead of the skill template's automatic commit.
- Preserve pre-existing untracked `.claude/` and `bash.exe.stackdump`; never stage them by a broad `git add -A`.
- Every delegated agent uses `model: 'sonnet'`. Do not add an effort override unless the owner explicitly requests one.

## Review Focus

1. An action succeeds at Reddit but its response is lost: exactly one dispatch, durable unknown outcome, cache invalidation, no automatic retry after restart. Tests: Tasks 6–8.
2. A profile/default/security setting changes while a write is queued: original account remains bound, stale policy/credential generation cancels before dispatch. Tests: Tasks 3, 5, 8.
3. Two CLI/MCP processes or two aliases use one account: no duplicated browser owner, lost ledger updates, quota bypass, or stale same-account cache. Tests: Tasks 2, 3, 6, 8, 9.
4. An unconfigured machine lacks Playwright, a browser binary, API credentials, or sampling: server/offline tools still start, diagnostics are accurate, no implicit installs or model-service calls. Tests: Tasks 1, 9, 13–15.
5. Reddit changes markup, redirects to login, returns HTML instead of JSON, or includes prompt injection: fail/handoff with no secret leakage, fake success, arbitrary click, or restriction-bypassing fallback. Tests: Tasks 4, 10–13.

---

## Execution, task graph and file ownership

The user chose **one encompassing dynamic workflow with fanned-out Sonnet agents**, preserved for execution. Never run parallel dynamic workflows: encode parallel agents, dependencies, integration, reviews, and repairs inside a single coordinator. The owner corrected this during execution; the already active disjoint runs may finish, then all remaining phases use one encompassing run. Use `Workflow` with bounded task arrays and `pipeline()` for implement → spec review → correctness/security review, with independent review as soon as a task completes. Use parallel tasks only when file ownership is disjoint and consumed contracts already exist. Report skipped agents/tasks; do not count an agent's final statement as verification.

An implementer must read this plan and the spec, write failing tests, run them and observe the intended failure, implement, then run targeted tests and the relevant regression suite. Reviews return specific defects; the task's owner fixes them and reruns verification. Main-loop integration checks shared signatures and runs the full suite after each wave. Never run a destructive merge/reset to reconcile agent edits. Shared-workspace agents own disjoint files; a task editing a shared seam waits for the previous owner to finish. Worktree isolation is reserved for changes that otherwise conflict; do not assume uncommitted contract files are present in a fresh worktree.

Dependency waves:

```text
Wave A: T1 contracts/settings || T2 protected files/locks
Wave B: T3 registry/accounts (A) || T5 approvals (A)
Wave C: T4 secrets/profile API (T2,T3) || T6 ledger/boundary (T1,T2,T5)
Wave D: T7 official API adapter (T1,T6) || T9 Playwright/session (T2,T3,T4)
Wave E: T8 dispatcher integration (T3–T7) || T12 continuations (T1,T3)
Wave F: T10 replay (T8,T9) || T11 UI adapters (T8,T9,T12)
Wave G: T13 MCP (T8–T12) || T14 CLI (T3–T12)
Wave H: T15 packaging/docs/full offline verification (all preceding)
Gate:   T16 separately authorized live verification and coverage closure
```

`src/config.js` belongs to T1 initially; later tasks use its exports and propose changes through the integrator. `src/actions.js`, `src/client.js`, and `src/session.js` belong to T7, then T8 sequentially. T13 owns `src/mcp-server.js`/`src/mcp.js`/`src/http.js`. T14 owns `src/cli.js` and new command modules. T15 owns manifests/build/docs once feature writers settle.

### File structure

| Files | Responsibility |
|---|---|
| `src/operations.js`, `src/errors.js`, `src/config.js`, `src/validation.js` | Operation/tool inventory, public classified errors, independent runtime settings and API validation, common validation. |
| `src/secure-fs.js`, `src/locks.js` | Atomic writes, Windows local storage protections, nonce-owned process locks. |
| `src/profiles.js`, `src/accounts.js` | Authoritative registry/default, account identity binding, snapshots and generations. |
| `src/secrets.js`, `src/migration.js`, `src/store.js` | Profile OS-store refs, encrypted optional session export, explicit legacy import. |
| `src/approvals.js`, `src/attempts.js`, `src/write-boundary.js`, `src/safety.js` | Configurable approval policy, durable admission/outcomes, one cross-backend write boundary. |
| `src/dispatch.js`, `src/session.js`, `src/backends/api.js` | Frozen per-call context, selection/capabilities, legacy and named API sessions. |
| `src/browser/doctor.js`, `src/browser/session.js`, `src/browser/identity.js` | Optional dependency diagnostics, dedicated session ownership, verified identity. |
| `src/backends/replay.js`, `src/replay/mappings.js`, `src/replay/transport.js` | Evidenced finite request mappings, scoped credentials, no raw proxy. |
| `src/backends/browser.js`, `src/browser/adapters/{reads,writes}.js`, `src/browser/steps.js` | Known rendered-UI operations, guarded commits, task-bound host assistance. |
| `src/continuations.js`, `src/coverage.js` | Account/backend-bound opaque UI pagination and honest operation status. |
| `src/mcp-server.js`, `src/mcp.js`, `src/http.js`, `src/mcp-browser.js` | Stable MCP inventory, local-only helpers, optional sampling capability checks. |
| `src/cli.js`, `src/cli-profiles.js`, `src/cli-browser.js` | Existing commands plus profile/security/setup management. |
| `scripts/build-mcpb.js`, `package.json`, `package-lock.json`, `.env.example`, `docs/**` | Optional dependency/build boundaries and reproducible docs/evidence. |
| `tests/fixtures/browser/**`, `tests/fixtures/replay/**`, new `tests/*.test.js` | Sanitized synthetic fixtures and injected offline transports; never real session captures. |

Names below are the shared contracts. Body details not pinned by tests are left to the implementer; no unimplemented export may be invented ad hoc by a consuming task. Types described here are JSDoc/plain-JS shapes, not TypeScript compilation requirements.

## Shared contracts

- `Operation`: `{ tool, action, kind: 'read'|'write'|'offline'|'rss', policyKey, target, contentHash?, requiresIdentity, args }`. `policyKey` is the exact tool name, not a shared action function name. Only normalized/validated arguments enter the dispatcher.
- `ProfileSnapshot`: immutable `{ id, alias, expectedUsername, accountKey?, accountId?, generation, credentialGeneration, policyGeneration, enabledBackends, backendPreference, visibility, confirmations, api, passwordLoginEnabled }`. `api` contains public client/app metadata and secret **references**, not values.
- `CallContext`: `{ callId, profile, accountKey?, operation, backendId, signal, deadlineAt }`; capture profile once, replace backend only during eligible pre-dispatch fallback, never account.
- Backend: `{ id, capabilities(ctx), probe(ctx), read(op,ctx), prepareWrite(op,ctx), commitWrite(prepared,ctx), close() }`. `prepareWrite` must not externally mutate. `commitWrite` is invoked only by the shared boundary. SDK/DOM/HTTP objects never appear in public results.
- Result: `{ data, meta }`, preserving legacy action data in `data`; `meta` contains safe profile alias, username, backend, completeness/missing fields, outcome/attempt ID, and optional UI continuation. MCP renders legacy JSON text plus additive structured metadata; CLI keeps legacy output unless `--json` is requested.
- Failure: `OperationError(code, message, { outcome, retryAfterMs, safeDetails })`. Canonical codes: `PROFILE_REQUIRED`, `PROFILE_NOT_FOUND`, `PROFILE_IN_USE`, `IDENTITY_MISMATCH`, `IDENTITY_UNVERIFIED`, `BACKEND_UNAVAILABLE`, `UNSUPPORTED_OPERATION`, `PARAMETER_UNSUPPORTED`, `APP_ONLY_READ_ONLY`, `APPROVAL_REQUIRED`, `POLICY_CHANGED`, `LOGIN_REQUIRED`, `USER_HANDOFF_REQUIRED`, `THROTTLED`, `CONTINUATION_INVALID`, `CONTINUATION_EXPIRED`, `CURSOR_CONFLICT`, `STEP_STALE`, `BROWSER_DEPENDENCY_MISSING`, `BROWSER_BINARY_MISSING`, `OUTCOME_UNKNOWN`.
- Outcomes: `PREPARED`, `WAITING_FOR_USER`, `DISPATCHED`, `SUCCEEDED`, `FAILED_KNOWN`, `OUTCOME_UNKNOWN`. A definite protocol rejection is known failure, not automatically unknown; a lost/malformed completion response is unknown.

### Task 1: Independent settings and validated operation inventory

**Files:** Create `src/operations.js`, `src/errors.js`, `src/validation.js`, `tests/operations.test.js`, `tests/runtime-settings.test.js`. Modify `src/config.js` and extract validators from `src/actions.js` without changing action behavior.

**Interfaces:** `readRuntimeSettings(env=process.env) -> Settings`; `readLegacyApiConfig(env=process.env) -> ApiConfig`; preserve `loadConfig(env)` as the legacy strict API wrapper. `describeOperation(tool,args,settings) -> Operation`; `REDDIT_TOOL_NAMES -> frozen string[32]`; `OperationError` and outcome constants from `src/errors.js`.

- [ ] **Step 1:** Write tests asserting `readRuntimeSettings({})` succeeds without an ID, `loadConfig({})` still fails with `REDDIT_CLIENT_ID`, offline/RSS descriptions require no profile, invalid input performs no backend work, and policy keys distinguish edit/delete post vs comment, save vs unsave, subscribe vs unsubscribe. Assert 32 unique tool names and 11 writes. Preserve password exact characters and placeholder behavior.
- [ ] **Step 2:** Run `node --test tests/operations.test.js tests/runtime-settings.test.js`; observe missing-export failures.
- [ ] **Step 3:** Implement the interfaces and validate common tool inputs, including canonical Reddit target IDs/URLs, query filters, limits, and ownership-kind requirements. `readRuntimeSettings` defaults confirmations off and visibility visible; do not read the keychain here. Avoid exposing env credentials in settings/diagnostics.
- [x] **Step 4:** Run the new tests and `node --test tests/config.test.js tests/config-auth.test.js tests/placeholders.test.js tests/actions.test.js tests/reads.test.js tests/writes.test.js`; expect zero failures.
- [ ] **Step 5:** Review/checkpoint this diff without committing; freeze exports for consumers.

### Task 2: Protected local files and process-owned locks

**Files:** Create `src/secure-fs.js`, `src/locks.js`, `tests/secure-fs.test.js`, `tests/locks.test.js`.

**Interfaces:** `writeAtomic(path,data,{fs,sleep,newId})`; `ensureProtectedRoot(path,{platform,run,fs}) -> protection`; `acquireLease(path,{kind,owner,fs,clock,isAlive,timeoutMs}) -> { assertHeld(),heartbeat(),release() }`; `withLease(path,options,fn)`.

- [ ] **Step 1:** Write tests for UNC/shared/roaming refusal, Windows ACL repair/verification by injected command runner, a failed replacement leaving old JSON intact, EPERM/EBUSY bounded retry with no unlink-first window, live owner refusal, wrong-nonce release preserving lock, stale reclaim requiring dead owner and unchanged nonce, PID reuse/alive owner refusal. Include a spawned-Node two-process mutual-exclusion test using temporary storage.
- [ ] **Step 2:** Run `node --test tests/secure-fs.test.js tests/locks.test.js`; confirm intended failures.
- [ ] **Step 3:** Implement NTFS/local-path/ACL checks and atomic replacement. Use OS APIs/cmdlets via argument-safe runner, not shell-concatenated paths; scope ACLs to the created tool root rather than changing an arbitrary ancestor. Do not assume chmod suffices. Lease metadata is non-secret, PID/owner-nonce bound; never kill a browser during repair. All waits bounded.
- [x] **Step 4:** Rerun tests; expect no lost updates or overlapping critical sections. Add a Windows-only local protection integration test that operates solely on a temporary directory and skips with a reason elsewhere.
- [ ] **Step 5:** Review/checkpoint; no commit.

### Task 3: Named profiles, defaults, and account identity

**Files:** Create `src/profiles.js`, `src/accounts.js`, `tests/profiles.test.js`, `tests/accounts.test.js`, `tests/profile-concurrency.test.js`.

**Interfaces:** `createProfileRegistry({homeDir,fs,clock,newId,leases})` with async `list()`, `add({alias,expectedUsername})`, `get(selector)`, `setDefault(selector|null)`, `update(id,patch,{expectedGeneration})`, `snapshot(selector)`, `checkSnapshot(snapshot)`, `remove(id,approval)`. `resolveProfile({registry,explicitProfile,legacyConfigAvailable}) -> snapshot|legacy-handle`. `createAccountRegistry(...).bind({profileId,accountId?,username}) -> {accountKey,accountId,username}`.

- [ ] **Step 1:** Write tests for case-insensitive aliases; rejection of empty/traversal/Windows device names; opaque storage IDs; atomic default visible to a second registry instance; explicit > default > isolated legacy precedence; no guessing when profiles exist without a default; no profile requirement for offline/RSS. Two verified aliases for the same account must share one key; conflicting account ID/username binding must block. A changed default must not mutate an existing snapshot.
- [ ] **Step 2:** Run `node --test tests/profiles.test.js tests/accounts.test.js tests/profile-concurrency.test.js`; observe failure.
- [ ] **Step 3:** Implement authoritative `<home>/profiles.json` containing registry/profile metadata and the single `defaultProfileId`; do not duplicate mutable profile metadata in a second file. Include independent credential/policy generations. Restrict update patch keys so callers cannot rebind identity or insert secret fields. Account directory names derive from hashes, not aliases. Username-only UI identity resolves through the same account registry as known IDs.
- [x] **Step 4:** Rerun tests including competing registry/default updates. Deleting the default sets it null; never choose another profile silently.
- [ ] **Step 5:** Review/checkpoint; publish contract to remaining lanes.

### Task 4: Profile secrets, explicit migration, and API credentials

**Files:** Create `src/secrets.js`, `src/migration.js`, `tests/profile-secrets.test.js`, `tests/profile-migration.test.js`. Modify `src/store.js` only for an injected, namespaced profile-store adapter; preserve legacy exports.

**Interfaces:** `createProfileSecretStore({keyring})` with `ref(profileId,name)`, async `get(ref)`, `set(ref,value)`, `delete(ref)`; `sealSession(value,{key,profileId,version}) -> Buffer`; `openSessionState(buffer,{key,profileId,version}) -> object`; `readProfileApiConfig(snapshot,{secretStore,settings}) -> ApiConfig`; `importLegacyProfile({registry,accounts,secretStore,legacyConfig,legacyStore,verifyIdentity}) -> profileId`.

- [ ] **Step 1:** Write tests asserting named profiles never inherit process-wide refresh tokens/passwords, secrets never enter registry/error JSON, tampered ciphertext/wrong profile associated data fail closed, large session payload does not go into a single Credential Manager entry, failed identity/migration leaves old config/log/keychain untouched, successful import preserves source until verification and registers one account guard. Test same-app/different-token profiles and app-only profile metadata.
- [ ] **Step 2:** Run `node --test tests/profile-secrets.test.js tests/profile-migration.test.js`; confirm failures.
- [ ] **Step 3:** Implement separate profile keyring service/opaque account refs; AES-256-GCM optional session export with random nonce and authenticated profile/version association. Persist encrypted state through Task 2. Legacy env password remains environment-only; stored browser password is a separate explicit enrollment secret. Legacy write history is associated only with a verified imported account, never discarded/reassigned by guessing.
- [x] **Step 4:** Run targeted tests and existing `tests/oauth.test.js tests/session.test.js`; expect no token-rotation regression.
- [ ] **Step 5:** Review/checkpoint. Do not create real keyring entries in tests.

### Task 5: Configurable action approvals and trusted settings proposals

**Files:** Create `src/approvals.js`, `tests/approvals.test.js`, `tests/security-proposals.test.js`.

**Interfaces:** `resolveApprovalPolicy({global='off',perAction={}},tool,{requestConfirmation=false}) -> boolean`; `createApprovalStore({homeDir,leases,clock,newId})` with `propose(binding,patch)`, `approveLocally(proposalId,{prompt})`, `consume(binding)`, `status(id)`; `binding = {profileId,accountKey,tool,targetHash,contentHash,policyGeneration,expiresAt}`. Default approval expiry: 120 seconds; single use.

- [ ] **Step 1:** Write tests for default-off including deletes, global/per-action combinations for all 11 keys, one-call escalation only, `confirm:true` never satisfying required approval by itself, expiry/replay/wrong-profile/wrong-content rejection, security mutations requiring local approval, operational default/visibility selection not weakening security. Assert proposal/status outputs contain no reusable approval secret.
- [ ] **Step 2:** Run `node --test tests/approvals.test.js tests/security-proposals.test.js`; observe failures.
- [ ] **Step 3:** Implement hashed approval binding and interactive local user approval port. Use persisted proposals/approvals with atomic consume and generation checks. No MCP tool can approve its own proposal. Credentials are entered through local hidden input, not proposal text. Document that same-user unrestricted shell permissions are outside this protection.
- [x] **Step 4:** Rerun tests, including simultaneous attempts consuming one approval. Default-off still requires valid operation/account and guard admission.
- [ ] **Step 5:** Review/checkpoint; no commit.

### Task 6: Durable account-level admission and write outcomes

**Files:** Create `src/attempts.js`, `src/write-boundary.js`, `tests/attempts.test.js`, `tests/write-boundary.test.js`, `tests/write-concurrency.test.js`. Modify `src/safety.js` to reuse existing fingerprint/cap logic without two independent guards.

**Interfaces:** `createAttemptLedger({homeDir,accountKey,leases,clock,newId})` with `reserve(descriptor,context)`, `markDispatched(id)`, `settle(id,outcome)`, `listPending()`, `resolveLocally(id,resolution)`; `createWriteBoundary({ledger,policy,approvalStore,revalidate,clock,sleep,limits,cacheGeneration})` with `run({operation,context,prepare,commit}) -> BackendResult`. `createCacheGeneration({homeDir,accountKey,...}).current()/bump()` are async.

- [ ] **Step 1:** Write tests: one call reserves once and commits once; app-only/validation/policy failure reserves nothing; same text concurrently in PREPARED/DISPATCHED/UNKNOWN blocks the second call; unknown consumes quota after process restart; known rejection frees reservation; crashed-dispatched stays unknown; provably undispatched dead preparation may expire; quota and duplicate state cannot be reset through another alias. Both success and unknown increment account cache generation. Test spacing with a fake clock, 24-hour duplicate window, 30/hour standard and 10/hour strict existing defaults.
- [ ] **Step 2:** Run `node --test tests/attempts.test.js tests/write-boundary.test.js tests/write-concurrency.test.js`; confirm failures.
- [ ] **Step 3:** Implement minimal hash/timestamp/operation/attempt/outcome ledger—no content text or secrets. Admission, scheduling, marking and settlement use account locks; never hold the account lock while asking a human, sleeping for a rate limit, or preparing a page. Reserve scheduling slots atomically and recheck generations/spacing immediately before dispatch. Durable mark precedes final network send/UI click. Unknown duplicates remain blocked until reconciliation/resolution or the documented duplicate window; pending uncertainty cannot be erased by a 500-entry truncation.
- [x] **Step 4:** Run targeted and existing safety tests. Use a two-process test to prove shared-account serialization/admission and separate-account independence. Unknown reconciliation is read-only and never silently resubmits.
- [ ] **Step 5:** Review/checkpoint one guarded path and crash cases.

### Task 7: Official API adapter and conservative mutation transport

**Files:** Create `src/backends/api.js`, `tests/api-backend.test.js`, `tests/mutation-outcomes.test.js`, `tests/account-cache.test.js`. Modify `src/actions.js`, `src/client.js`, `src/session.js`, existing client/auth/cache tests as required.

**Interfaces:** `createActions({client,guard?,writes?,footer,authMode})` accepts exactly one guard adapter: old `guard.run` or new `writes.run`; both together throw. Pass operation tool/kind descriptors into the new boundary, preserving normalized response data. `createApiBackend({snapshot,config,client,boundary}) -> Backend`. `createRedditClient` gains `invalidate()` and account/generation-aware GET cache options; mutation errors carry classified outcomes.

- [ ] **Step 1:** Write tests distinguishing the 11 tool policy keys behind the shared action methods; one boundary/reservation/fetch per write; POST network throw/5xx/invalid 2xx JSON becomes unknown and makes exactly one request; definite JSON rejection/401/403/429 makes one request and known failure; ordinary GET token refresh/throttle retries stay unchanged. Assert empty documented mutation response shapes can succeed only when operation-specific evidence establishes the state, not a generic `{}` fallback. Raw POST stays API-only and uses a `raw_post` policy/admission key.
- [ ] **Step 2:** Run `node --test tests/api-backend.test.js tests/mutation-outcomes.test.js tests/account-cache.test.js`; confirm intended failures, not unrelated import errors.
- [ ] **Step 3:** Add API adapter and inject one shared guarded boundary while preserving existing validation/shaping. Disable automatic resends of mutating API requests (including 401/429/RATELIMIT handling); keep legitimate preflight token renewal and GET retries. Reject unparseable mutation completion rather than `unwrap` returning false success. Check cross-process account generation before cached reads and invalidate across same-account backends on success/unknown.
- [x] **Step 4:** Run all existing action/read/write/client/auth/cache/session tests plus targeted tests. Update old POST-retry assertions deliberately; retain GET regression coverage. API app-only identity/self-history/writes are preflight refusals.
- [ ] **Step 5:** Review/checkpoint; only after this task may T8 edit these shared seams.

### Task 8: Frozen-profile operation dispatcher and session resolution

**Files:** Create `src/dispatch.js`, `tests/dispatch.test.js`, `tests/profile-switching.test.js`, `tests/backend-capabilities.test.js`. Modify `src/session.js` for named API session resolution and lifecycle.

**Interfaces:** `createDispatcher({registry,accounts,backendFactories,settings,approvals,leases,clock})` with `execute(tool,args,{profile?,backend?,requestConfirmation?,signal?}) -> Result`, `status(selector)`, `closeProfile(id)`, `close()`. Backend instances are isolated by profile/credential generation; offline/RSS do not instantiate a profile session.

- [ ] **Step 1:** Write tests for explicit/default/legacy precedence; enabled API→replay→browser selection only on eligible pre-dispatch unavailability; no fallback for configured-invalid credentials, app-only writes, denied scope, throttle, challenge, unsupported essential parameters after commit, or unknown write. A changed default never changes queued calls; changed security/credentials cancel before dispatch. Same-account aliases share guard/cache invalidation. No automatic browser enrollment, install, or real login while resolving a missing backend.
- [ ] **Step 2:** Run `node --test tests/dispatch.test.js tests/profile-switching.test.js tests/backend-capabilities.test.js`; observe failures.
- [ ] **Step 3:** Implement operation-level routing and cleanup. `probe` is a separately classified authentication/identity step; profile status alone never proves identity. Bind account before authenticated writes and freeze backend after dispatch. `auto` cannot promote an intentionally app-only API identity into user write capability. Public feed RSS downgrade is explicit/opt-in and completeness-labeled.
- [x] **Step 4:** Run targeted tests and `npm test`; expect all offline tests pass.
- [ ] **Step 5:** Review/checkpoint integration contracts for backend writers.

### Task 9: Optional Playwright setup, dedicated sessions and recovery

**Files:** Create `src/browser/doctor.js`, `src/browser/session.js`, `src/browser/identity.js`, `tests/browser-doctor.test.js`, `tests/browser-session.test.js`, `tests/browser-recovery.test.js`. Modify package peer metadata via T15 integrator, not concurrent manifest edits.

**Interfaces:** `browserDoctor({settings,profile,loadPlaywright,fs}) -> safeStatus`; `setupBrowser({installPackage,installBrowser,runner,version}) -> report` only on explicit local setup invocation. `createBrowserSessionManager({registry,secretStore,leases,loadPlaywright,clock})` with `open(snapshot,{visibility})`, `identity(id)`, `renew(id,{allowPasswordLogin})`, `close(id)`, `closeAll()`. Returned internal session includes `context`, `requestContext`, `account`, `credentialGeneration`; it is never a public tool result.

- [ ] **Step 1:** Write tests for separate package/binary/locked/missing-login states and zero implicit installer calls; dynamic import not invoked for API/RSS; visible default, headless selection and ask handoff; owner retained across calls, no second profile launch, 15-minute idle close only when no task exists; mismatch blocks; legacy passwords not reused; one bounded auto-login attempt followed by human handoff. Challenge leaves a usable visible handoff without resubmitting. Session state/cookies never enter safe status or observations.
- [ ] **Step 2:** Run `node --test tests/browser-doctor.test.js tests/browser-session.test.js tests/browser-recovery.test.js`; confirm failures.
- [ ] **Step 3:** Implement dedicated persistent contexts, local locking, normal cookie updates, verified identity, cleanup and recovery. Use standard Playwright only, no launch-flag stealth or TLS/browser impersonation. Recover only normal expired authentication; CAPTCHA/2FA/security/lockout abort automated recovery. Password opt-in is consumed from Task 4 store after Task 5 local approval. Freeze account; sign-out/reset distinguish remote logout from local deletion.
- [x] **Step 4:** Rerun tests with a fake Playwright module and synthetic page/context; real browser not needed. Cross-process ownership rejects a second CLI while MCP owns that profile, but independent local settings approval remains usable.
- [ ] **Step 5:** Review/checkpoint; record tested Playwright version later, never fabricate it now.

### Task 10: Finite experimental replay mappings and session transport

**Files:** Create `src/backends/replay.js`, `src/replay/mappings.js`, `src/replay/transport.js`, `tests/replay-transport.test.js`, `tests/replay-mappings.test.js`, `tests/fixtures/replay/**`, `docs/experiments/replay.md`.

**Interfaces:** `createReplayTransport({sessionManager,secretStore,allowedDestinations,requestFactory})` with `request(mapping,input,context)`; `REPLAY_MAPPINGS[operation] -> {method,origin,path,inputSchema,responseSchema,identity,sourceRef,status}`; `createReplayBackend({transport,mappings,boundary}) -> Backend`. Credential binding is internal; no arbitrary path/header/cookie arguments.

- [ ] **Step 1:** Inspect and pin the actual Apollo-Reborn source/docs commit for mappings being used; follow Context7/library verification rules. Record evidence versus assumptions in the ledger; create synthetic fixtures, not real cookies/content captures. Write failing tests for finite host/path/method allowlists, redirect credential stripping, HTML/block/CSRF errors, expiry versus security challenge, mutation ambiguity, Set-Cookie synchronization, wrong profile and missing mapping. Verify unknown/private mapping is unsupported, never guessed or enabled by one successful identity read.
- [ ] **Step 2:** Run `node --test tests/replay-transport.test.js tests/replay-mappings.test.js`; observe failures.
- [ ] **Step 3:** Implement only inspected, operation-specific mechanisms needed by the 32-tool vocabulary. Web-cookie JSON, modhash/CSRF forms, browser-token bearer and GraphQL are candidate mechanisms, not automatic broad access. Start with identity and reads; add each evidenced write mapping through Task 6. Keep experimental browser mechanisms explicitly enabled per profile and flagged unverified until authorized local testing. Do not replay against arbitrary private endpoints or reroute a refused/challenged operation.
- [x] **Step 4:** Run replay plus dispatcher/boundary tests, asserting exactly one network invocation per mutation and no leaked header/body/token in errors. If upstream evidence is unavailable, record the blocker and leave that mapping unsupported rather than fabricate a response.
- [ ] **Step 5:** Review/checkpoint. Live acceptance is T16, not authorized here.

### Task 11: Rendered-UI operation adapters and restricted visual assistance

**Files:** Create `src/backends/browser.js`, `src/browser/adapters/reads.js`, `src/browser/adapters/writes.js`, `src/browser/steps.js`, `tests/browser-reads.test.js`, `tests/browser-writes.test.js`, `tests/browser-steps.test.js`, `tests/browser-redaction.test.js`, `tests/fixtures/browser/**`.

**Interfaces:** `createBrowserBackend({sessions,adapters,boundary,tasks}) -> Backend`; `createBrowserTasks({clock,newId})` with `create(context)`, `observe(taskId,{kind})`, `step(taskId,{observationId,step,args})`, `handoff(taskId)`, `close(taskId)`; adapters implement backend `prepareWrite`/`commitWrite`, known read parsers, and safe preparation steps.

- [ ] **Step 1:** Write synthetic modern Reddit DOM/accessibility fixtures and tests for requested identity/feed/time/search/rules/flairs/user/saved/comment parameters, scoped post/comment targets, wrong-account rejection, expired/stale element refs, partial-tree disclosure and missing IDs. Write tests for all 11 guarded mutations and state verification, including an unfamiliar submit button yielding unsupported rather than a click. Generic click/evaluate/fetch/header-edit steps must be rejected. CAPTCHA/login/2FA/recovery screens refuse model screenshot capture and yield human handoff; ordinary page prompt injection cannot change a target/account/policy.
- [ ] **Step 2:** Run `node --test tests/browser-reads.test.js tests/browser-writes.test.js tests/browser-steps.test.js tests/browser-redaction.test.js`; observe failures.
- [ ] **Step 3:** Implement modern desktop `www.reddit.com` English UI adapters with role/accessibility locators and finite operations. Keep read/sample bounds and disclosed completeness. Safe host steps include navigation within the task, scrolling, ordinary non-secret field preparation, sorting and known branch expansion. Final mutations are committed only inside Task 6. No unrestricted click tool or external desktop control. Unexpected UI/A-B variant fails closed; no silent fallback to Old Reddit after a block.
- [x] **Step 4:** Run fixtures and boundary tests. For a mapping that cannot satisfy an essential parameter (e.g. branch IDs, search type, exact flair template IDs), report `PARAMETER_UNSUPPORTED` and record a gap; never claim visible text is complete API parity. Defaults/metric placeholders are not proof of coverage.
- [ ] **Step 5:** Review/checkpoint; all browser live statuses remain unverified until T16.

### Task 12: UI continuation and completeness contracts

**Files:** Create `src/continuations.js`, `tests/continuations.test.js`, `tests/result-completeness.test.js`.

**Interfaces:** `createContinuationStore({clock,newId,ttlMs=300000})` with `issue({profileId,accountKey,backend,operation,filterHash,credentialGeneration,taskId,state}) -> token`, `resolve(token,binding)`, `expireTask(taskId)`; `normalizeBackendResult(data,meta) -> Result`.

- [ ] **Step 1:** Write tests for exact API `after` round-trip, UI `after:null` plus separate continuation, mixed cursor rejection, wrong-profile/account/backend/filter/generation rejection, five-minute expiry, restart invalidation, task close invalidation, missing fields explicitly unavailable rather than zero. Keep scalar/array/object legacy API data unchanged.
- [ ] **Step 2:** Run `node --test tests/continuations.test.js tests/result-completeness.test.js`; observe failures.
- [ ] **Step 3:** Implement opaque unpredictable tokens bound to an in-memory task and safe metadata. Tokens contain no credentials/serialized page content. API cursor cannot be silently handed to UI. Resource cleanup closes task state at expiry; expiry never silently restarts a write/read under a new default profile.
- [x] **Step 4:** Rerun tests and relevant backend read tests.
- [ ] **Step 5:** Review/checkpoint.

### Task 13: Stable MCP inventory, profile helpers and optional sampling

**Files:** Create `src/mcp-browser.js`, `tests/mcp-profiles.test.js`, `tests/mcp-browser.test.js`, `tests/mcp-sampling.test.js`. Modify `src/mcp-server.js`, `src/mcp.js`, `src/http.js`, `tests/mcp.test.js`, `tests/http.test.js`.

**Interfaces:** `createRedditMcpServer({dispatcher,transport='stdio',browserHelpers,samplingEnabled=false})`; preserve function-getter injection as a compatibility adapter for existing tests. Process-scope session manager belongs to `src/mcp.js`. `toolInventory({transport}) -> string[]` is deterministic. Local helper names: `reddit_profiles_list`, `reddit_profile_current`, `reddit_profile_default_set`, `reddit_settings_get`, `reddit_settings_propose`, `reddit_browser_status`, `reddit_browser_open`, `reddit_browser_observe`, `reddit_browser_step`, `reddit_browser_handoff`, `reddit_browser_close`.

- [ ] **Step 1:** Write spawned-stdio/fake-dispatcher tests for 32+11 stable local tool names across login/default/dependency states, exactly 32 original HTTP tools, profile/backend inputs and separate continuation, optional `confirm` schema, application policy enforcement and annotations as hints. Global-on with no trusted approval must dispatch zero writes, even with `confirm:true`. HTTP browser/replay selection is rejected before resolving a browser. All registry tests use a temporary `REDDIT_CLI_HOME`.
- [ ] **Step 2:** Write sampling tests for missing client capability, declined request, unsupported negotiated protocol, bounded timeout, one-step assistance cap, no tools/model-provider SDK, no approvals/security/CAPTCHA handling from sampled output. Ordinary image/text observation results still work with sampling disabled. Run new tests and observe failures.
- [ ] **Step 3:** Implement wrapper resolution once per call and additive structured metadata while preserving legacy JSON text. Keep tasks/provider calls host-driven. Request sampling only when enabled and supported by the installed SDK's negotiated capabilities; otherwise return observations. No client support promises without a measured handshake. Safe error formatting never returns raw SDK/request/page dumps.
- [x] **Step 4:** Run `node --test tests/mcp.test.js tests/mcp-profiles.test.js tests/mcp-browser.test.js tests/mcp-sampling.test.js tests/http.test.js` and the full suite.
- [ ] **Step 5:** Review/checkpoint shared constructor compatibility and local-only browser scope.

### Task 14: CLI enrollment, profile/default controls and trusted local approval

**Files:** Create `src/cli-profiles.js`, `src/cli-browser.js`, `tests/cli-profiles.test.js`, `tests/cli-browser.test.js`, `tests/cli-policy.test.js`. Modify `src/cli.js`, `tests/cli.test.js`.

**Interfaces:** `addProfileCommands(program,deps)`, `addBrowserCommands(program,deps)`, `addBackendOptions(command)`. Commands follow spec §11.6: profile add/list/default/status/configure/approve-settings/credentials/logout/remove; browser doctor/setup; existing actions gain `--profile`/`--backend`, optional `--json`, UI continuation as applicable. `--yes` never overrides a stored required confirmation policy.

- [ ] **Step 1:** Write spawned/fake-TTY tests for default selection across commands, explicit profile override, environment legacy unchanged, profile-owned API login/logout/token selection, browser enrollment visible by default, TTY-only hidden credentials/approval, no secret argv/env/JSON values, local-only setup explicit flags, dry-run creates no attempt and sends nothing. No API credential requirement for doctor/offline/RSS. Profile remove/default/logout distinguish local delete from observed remote logout.
- [ ] **Step 2:** Run `node --test tests/cli.test.js tests/cli-profiles.test.js tests/cli-browser.test.js tests/cli-policy.test.js`; observe failures.
- [ ] **Step 3:** Wire pure/injectable command modules to shared dispatcher/policy/session services. Explicit settings proposals show target and risks locally and require a trusted user action; no approval tokens exposed to MCP. `token` never prints browser session secrets and cannot be repurposed into a cookie-export command. Raw `api` remains official-API-only.
- [x] **Step 4:** Rerun tests and `node src/cli.js --help`, `node src/cli.js profile --help`, `node src/cli.js browser doctor --help`. Verify errors and results use appropriate stdout/stderr and preserve MCP stdout purity.
- [ ] **Step 5:** Review/checkpoint; no actual credential storage/browser opening during tests.

### Task 15: Packaging, documentation and full offline verification

**Files:** Modify `package.json`, `package-lock.json`, `scripts/build-mcpb.js`, `.env.example`, `CLAUDE.md`, `README.md`, existing docs listed in spec §13. Create `src/coverage.js`, `docs/browser-mode.md`, `docs/backend-coverage.md`, `tests/coverage.test.js`, `tests/packaging.test.js`; update `docs/experiments/replay.md` and create `docs/experiments/browser-ui.md`.

**Interfaces:** `TOOL_COVERAGE` is keyed by all 32 exact names and backend, with status `implemented-offline-tested|live-verified|unsupported|not-yet-tested`, platform, checkedAt, missingFields, blockers, evidenceRef. Do not mark an operation implemented just because a helper or transport exists.

- [ ] **Step 1:** Write tests that every tool/backend has a coverage entry, no unexplained live-verified status exists, reference/docs tool inventories match, and the MCPB build recursively includes required official-API modules. Test API/RSS startup without Playwright installed; HTTP/Docker/MCPB reject browser/replay without importing its package or loading profiles. Package manifest declares Playwright as an optional peer (`peerDependenciesMeta.playwright.optional=true`), not an auto-installing runtime/optional dependency.
- [ ] **Step 2:** Run `node --test tests/coverage.test.js tests/packaging.test.js`; observe failures.
- [ ] **Step 3:** Set a verified/tested Playwright version/range after checking current official docs/package metadata at implementation time; provide exact local setup/install commands. Refactor bundle copying for nested official-API dependencies and keep browser dependencies/state/assets out. Add narrow CLAUDE.md exceptions matching the approved design rather than deleting security rules. Document every public control, confirmation-default change, Windows protection boundaries, user-handoff behavior, replay/UI distinctions, sampling uncertainty, unknown writes and experimental limitations. Explain that browser content observations reach the host model while credentials do not.
- [ ] **Step 4:** Run `npm test`; `git diff --check`; JSON validation for manifests/coverage; a relative docs link/anchor check; a tracked/new-file secret scan. Run `npm run mcpb` only if declared packaging dependencies are installed; if dependency setup is needed, install declared dependencies as ordinary setup, not hidden browser downloads. Unpack/import/stdio-smoke the API bundle offline. Build/smoke Docker only if Docker is available and the change touched its dependencies/entry path; report actual results, not previous-run assumptions.
- [ ] **Step 5:** Launch bounded Sonnet workflow reviewers over disjoint concerns (account isolation/credentials; dispatch/uncertain writes; MCP/CLI/build compatibility), then adversarially verify findings, fix confirmed defects, rerun targeted/full tests. Report exact tests/builds/gaps and leave changes uncommitted until requested. Do not call browser implementation complete while T16 or operation gaps remain.

### Task 16: Separately authorized Windows live verification and closure

**Files:** Update `docs/experiments/{replay,browser-ui}.md`, `docs/backend-coverage.md`, `src/coverage.js`; change implementation only to fix observed defects with offline regression tests.

**Interfaces:** An authorization record names profile/account, permitted public/read targets, sandbox subreddit, operation kinds, maximum mutation count, newly created content allowed for edit/delete, and permission to observe the corresponding redacted request behavior. No raw credentials/network dumps are retained.

- [ ] **Step 1:** Stop before authenticated requests and ask for this scoped test authorization. Earlier login/support-request permission is not authorization. If absent, finish/report offline work and keep this task blocked.
- [ ] **Step 2:** With authorization, verify local Windows dependency installation and profile protections, manual login and identity; compare explicit API/replay/UI selected account. Test profile default switching, independent owners, restart and expired-session/handoff without bypass attempts. Record exact successful/failed read results for every read tool/parameter class; do not infer write support.
- [ ] **Step 3:** Within the approved action budget, create test content only in the named sandbox; exercise reply/edit/delete/save/unsave/single vote/clear/join/leave as authorized. Assert target/account/state/permalink. A challenge, restriction, or unknown outcome stops that test without rerouting/retrying. Do not run a scripted mass engagement loop merely to fill the table.
- [ ] **Step 4:** Turn each observed bug into a failing offline regression, fix it, rerun offline tests, and retest only within remaining authorization. Never reuse protected observations as public fixtures. Record date/platform/upstream ref/assumptions/outcome/completeness for each coverage row.
- [ ] **Step 5:** Report complete only if all 32 tools have an appropriate functioning no-dev-app route and verified evidence, or explicitly report remaining blockers/incomplete milestones and seek scope decisions. No commit/push/publication until asked.

## Plan self-review and reconciliations

- Spec coverage: profiles/default/API ownership/migration (T1–4,8,14); approvals (T5,13,14); durable safety/retry/cache (T6–8); dependency/session/recovery/storage (T2,4,9); replay evidence (T10,16); rendered UI/host tools (T11,13,16); pagination/completeness (T12); packaging/docs/coverage (T15); live authorization (T16).
- Review Focus tests are assigned above; no new task is only an untestable scaffold.
- All contracts use the same canonical backend IDs `api|replay|browser|rss`, uppercase error/outcome codes, tool-name policy keys, `ProfileSnapshot`, and async cache-generation reads.
- No `confirm:true` or sampled response is treated as a trusted approval; default-off changes ordinary actions only, not credential/security changes.
- Changes from agent suggestions: registry is authoritative (no duplicate metadata file), cross-process locks are v1, unknown outcomes invalidate cache, PREPARED/DISPATCHED reservations block duplicates, profile-free tools precede resolution, and the 32/32 completion target is not weakened by an honest unsupported ledger entry.
- Baseline measured before planning: `npm test` returned 104 pass, 0 fail. This is the pre-change baseline, not proof the new backends work.
- Planning workflow: three Sonnet agents, no missing lanes; no product changes, dependencies, live sessions, commits, or pushes during planning.

## Execution handoff

The method is already chosen: bounded dynamic workflows with parallel Sonnet implementers/reviewers, task ownership, TDD and integration gates. Review this plan before implementation. Approval authorizes offline implementation/setup, not T16's live-account experiments and not a commit/push.

## Integration verification (2026-10-21)

Run by the integration coordinator after every implementation lane finished. Offline only: no commits, staging, live Reddit/browser/Playwright/keyring calls, or real credential changes.

- [x] `node --check` the entry points and adapters (`mcp.js`, `mcp-server.js`, `cli.js`, `http.js`, `config.js`, `dispatch.js`, `write-boundary.js`, `backends/*.js`, `browser/{session,steps}.js`, `browser/adapters/*.js`, `replay/*.js`, `continuations.js`, `profiles.js`).
- [x] `npm test` over the whole tree. Final integration runs: 712 tests, 711 pass, 0 failures, 1 Windows symlink skip. Two environment-sensitive cases (approval-store lock contention and the Windows junction ACL check) surfaced only under full-suite CPU pressure; the lock-release retry is fixed with a regression, and the junction case passed on retry without code changes.
- [x] CLI offline: `--help`, `profile --help`, `profile add/list/default`, and `browser doctor` (typed `BROWSER_DEPENDENCY_MISSING`, exit 1, no install performed).
- [x] stdio MCP offline with a temporary `REDDIT_CLI_HOME` and no credentials: 32 Reddit tools plus 11 local helpers; `reddit_explain` serves offline; a continuation token is typed-refused; a write without profile credentials refuses before dispatch.
- [x] HTTP MCP offline: initialize succeeds, `tools/list` returns exactly the 32 API tools, an unauthenticated POST gets 401, and no browser helper is registered.
- [x] API bundle plan: 31 source files, no `browser/`, `replay/`, `backends/browser.js`, `backends/replay.js`, or CLI command modules; `backends/api.js` and `dispatch.js` are included.
- [x] Cross-component regressions added: a browser-backed read through the real dispatcher issues a UI continuation; continuation binding/refusal; production replay/browser factory unavailability includes its backend id; MCP forwards a continuation only to a dispatcher with a store; transient Windows lock busses are retried at release.
- [ ] T16 remains blocked: no live account, browser, Playwright install, keyring, replay evidence, or operation coverage verification is authorized by this offline pass.

## Documentation and evidence lane (Task 15, 2026-10-21)

- [x] `src/coverage.js` rebuilt as a per-tool, per-backend ledger with `unsupportedParameters`, missing fields, blockers, platform, date, and evidence refs. Replay and browser rows are `implemented-offline-tested` (not `live-verified`); `get_post_flairs` is unsupported on replay and browser, and browser also cannot implement `get_more_comments`.
- [x] `docs/backend-coverage.md` renders every ledger row and the pinned upstream evidence. `tests/coverage.test.js` checks ledger completeness, honest statuses, the unsupported operations, exact doc rows, and relative links/anchors.
- [x] Added `docs/browser-mode.md` and `docs/experiments/browser-ui.md`. Updated `README.md`, `CLAUDE.md`, `.env.example`, and `docs/{configuration,cli,mcp,security,deployment,extension,development,troubleshooting,how-it-works}.md`.
- [x] Playwright remains an optional peer pinned `^1.64.1`; documented install commands use `npm install --no-save --package-lock=false playwright@1.64.1` then `npx playwright install chromium`. No implicit install path exists.
- [x] `npm test`: 716 tests, 715 pass, 0 fail, 1 Windows symlink skip. `git diff --check` clean; `package.json` and `package-lock.json` parse.
- [ ] `npm run mcpb` and Docker were not rebuilt in this lane; packaging tests cover the bundle plan only. No live verification was attempted. T16 stays blocked.

## Final repair and verification (2026-10-21)

Offline verification of the Task 15 review findings. No commits, staging, live Reddit/browser/Playwright/keyring calls, or credential changes.

- [x] Post-target (`t3`) UI writes are scoped to `shreddit-post[id="t3_<id>"]` for prepare and commit; a missing target element is `UNSUPPORTED_OPERATION`, never a page-wide control fallback. Deletion evidence is scoped to the named post/comment; a page-wide `[deleted]` marker no longer proves a `delete_post`/`delete_comment` succeeded.
- [x] Browser operations on one profile are serialized in the backend (`exclusive`, with in-operation nesting via `AsyncLocalStorage`), and the dispatcher passes the process-scope task manager into the browser factory. Whole operations register with `createBrowserTasks.beginOperation`, so an idle/close sweep cannot tear down a profile while a queued write waits for its slot or approval.
- [x] The backend cache key includes `policyGeneration`, so a visibility/backend/confirmation change rebuilds the browser backend instead of reusing its first snapshot.
- [x] Profile removal checks the cross-process lease (`inspectLease`) when this process has no session; a live owner yields `PROFILE_IN_USE` and preserves metadata/secrets.
- [x] Replay empty write responses only accept the documented `{}` / `{json:{errors:[],data:{}}}` envelope; unrelated objects and alternate error envelopes become `OUTCOME_UNKNOWN`.
- [x] Unknown-outcome resolution has a local CLI route: `profile attempts [name]` and `profile resolve <name> <attempt-id> succeeded|failed [--note]`, backed by dispatcher `pendingAttempts`/`resolveAttempt` (derived account key for legacy profiles).
- [x] Raw POST is routed through the shared write boundary with the `raw_post` admission key (`dispatcher.executeRaw`, CLI `api POST`); GET remains the existing official-API path.
- [x] The MCPB manifest starts `mcp.js --api-only`; the plan excludes the local helper and browser/replay modules, and a planned-bundle stdio smoke reaches `initialize` and lists exactly 32 tools. Stdio started without the flag also degrades to API-only when browser modules are absent.
- [x] `npm test`: 732 tests, 731 pass, 0 fail, 1 Windows symlink skip. `git diff --check` clean; `package.json`/`package-lock.json` parse.
- [x] `npm run mcpb` built `dist/reddit-api-mcp.mcpb` (3.9 MB, win32); the staged bundle lists 32 tools and serves offline `reddit_explain`.
- [ ] T16 (live account/browser/replay/keyring verification) remains blocked; no mapping or selector is claimed live-verified.
