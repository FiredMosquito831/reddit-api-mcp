# Reddit browser backends and named profiles

**Date:** 2026-10-21  
**Status:** Owner-approved design on 2026-10-21; implementation plan in preparation. Not an implemented feature. Three Sonnet research lanes and a fresh Sonnet builder check completed. Review resolutions are recorded below.  
**Repository:** `reddit-api-automation-mcp`  
**First supported environment:** Windows, Node.js, Claude Code, local MCP over stdio.

## 1. Intent

Make the existing Reddit tool surface usable when an account has no Reddit Data API application credentials, while preserving the official API as the preferred path. Provide two additional, distinct backends:

1. **Experimental session replay:** requests authenticated by a session established by the user in a dedicated local Reddit browser profile.
2. **Playwright UI:** navigate and interact with Reddit's rendered website in that same profile.

Support several named account profiles and a changeable saved default. A backend changes how an action is performed, never which account performs it. Public RSS remains a limited, unauthenticated feed option while Reddit serves it. The glossary remains offline.

The goal is coverage of all 32 existing MCP tools. This is an acceptance target, not a claim that every API field, pagination mechanism, or action has a browser equivalent. An operation is unsupported until its implementation and outcome verification exist. No fabricated metrics, silently incomplete comment trees, or speculative endpoint mappings.

## 2. Decisions from the owner

These requirements were established in the design conversation:

- Preserve the official developer/API route; add replay and Playwright as additional routes.
- When API credentials do not exist, prefer experimental replay, then Playwright UI when that operation is unsupported or the backend is unavailable before dispatch. Allow users to choose their mode instead of forcing the order.
- Reuse the owner's own authenticated browser session, not someone else's credentials or client ID.
- Windows and Claude Code first; no new external model service or separate model API key.
- Use ordinary host-driven browser tool calls; optionally use MCP sampling when the actual client and installed protocol support it.
- Target all 32 existing tools, including the existing single-target writes.
- Browser visibility is configurable; visible is the default. An agent may ask the user which mode they prefer.
- Support multiple named profiles, with an option to choose and change a saved default.
- Additional application-level confirmations default to off, with global and per-action configuration. Host-level permission prompts remain under the host's control.
- An instructed agent may select profiles, change the default, choose enabled backends, and choose browser visibility. It must not silently weaken approval requirements or enable stored-password login.
- Optional automatic login may store credentials only with explicit opt-in and protected operating-system storage. Manual login remains available.
- The owner requested host-assisted handling of visual challenges before user handoff; this is host-policy/capability-dependent, not a promised ability to bypass CAPTCHA or account-security checks. Fresh 2FA and security approvals need a user-handoff path.
- Document architecture, setup, security, experimental steps, results, failures, and actual operation coverage.
- Delegated design, implementation, and review agents use Sonnet.

## 3. Non-goals and boundaries

- No new moderation-action, modmail, direct-message, report, chat, or Reddit Answers tools in this change. Using existing public reads to help a human review rules does not require inventing moderator capabilities.
- No bulk voting, batch engagement, coordinated account rotation, or using another account to escape a restriction. Named profiles are account selection, not a traffic-distribution mechanism.
- No borrowed client IDs, client impersonation, stealth patches, fingerprint spoofing, CAPTCHA-solver services, or bypassing security challenges, account locks, permission denials, or rate limits.
- No extraction from the user's everyday browser profile. Enroll dedicated profiles owned by this tool.
- No promise that browser replay is a sanctioned API, has OAuth scopes, or will remain available. Access terms and site behavior are distinct from technical feasibility.
- No automatic dependency/browser installation during an MCP operation.
- No browser-backed HTTP hosting, Docker support, or Desktop-extension packaging in the first version. Existing official-API functionality in those deployments must continue to work.
- No changes to production code, dependency installation, live account operations, public publishing, commits, or pushes as part of this design-only stage.

## 4. Approach and trade-offs

### 4.1 Considered approaches

| Approach | Advantages | Costs and decision |
|---|---|---|
| Official API only | Existing structured results and scoped grants | Preserve as preferred; does not solve missing app credentials. |
| Replay only | Potentially structured, browserless requests between authentication steps | Experimental, more privileged credentials, endpoint/session uncertainty; not sufficient as the sole alternative. |
| UI only | Operates the same visible actions the user can perform | Slower, markup-dependent, may not expose exact API metadata; retain as an additional operation backend. |
| Three backends with explicit capabilities | Preserves working paths and can route around unsupported implementations | Recommended; requires a routing contract and conservative handling of ambiguous writes. |

Replay does not mean "headless Playwright." A standalone request client has no browser engine. Headless and visible are modes of a running browser. Replay may need a browser again for login, JavaScript-mediated session renewal, or verification. Re-reading an expired token is not a renewal mechanism.

### 4.2 Evidence standard

Upstream Apollo-Reborn findings are prior art, not proof for this repository or the owner's account. Playwright documents shared browser/request cookie storage and standalone request contexts, but that does not establish that Reddit accepts either request path. The implementation must record the observed mechanism and result for each operation before enabling it.

Do not infer all writes work from a successful identity read. Do not infer a global app-creation policy from one anonymous request or a single failed form submission. Diagnose with redacted observations; do not try alternate endpoints to get around a refusal.

## 5. Profiles and identity

### 5.1 Named profiles

Use human-chosen, case-insensitively unique local aliases. Reject path separators, traversal, empty names, and reserved system/device names; generate storage directories from validated opaque IDs rather than aliases or Reddit usernames.

Each profile records non-secret metadata:

- Stable local profile ID and display alias.
- Expected Reddit username and last verified username/time.
- Enabled backends, explicit or automatic selection preference, and browser visibility.
- Approval policy and whether password-based re-login was explicitly enabled.
- References to operating-system secret-store entries, never secret values.
- Per-backend capability/test status; session status metadata, not cookies.

One profile is for one expected account. A profile cannot silently rebind itself after a browser account switch. If identity differs, block authenticated operations and require explicit re-enrollment. A token's mere presence does not verify identity.

### 5.2 API credentials are profile-owned too

Named profiles cover API as well as browser backends in the first version. A profile may have its own API client ID/app type, OS-store client secret and refresh-token references, and expected Reddit account. Sharing one explicitly configured app across profiles is allowed, but user tokens remain account/profile bound. Do not silently copy a process-wide client secret or refresh token into every profile. An app-only profile has app identity and public-read capability, not an implied human account.

The environment-only configuration remains an isolated legacy path until explicitly imported into a named profile. Import is a local interactive migration that verifies the account and preserves the legacy credential until the import succeeds. Ordinary profile selection never changes which API token belongs to that profile.

### 5.3 Selection and defaults

Precedence:

1. Explicit profile in a CLI option or MCP tool call.
2. Saved default profile.
3. Existing environment-only behavior as an isolated legacy profile when no named registry is configured.
4. Otherwise return `PROFILE_REQUIRED` and list safe profile aliases; do not guess or select the first profile.

The default is a local persisted setting. Changing it affects subsequent calls only. Resolve and freeze a profile snapshot at the start of each operation, including queued operations. If its security policy changes before a queued write dispatches, re-evaluate the current policy and cancel when necessary; never apply newly weakened settings retroactively to an already prepared operation.

Named profiles never inherit credentials from an unrelated process-wide legacy environment. Migration from existing keychain/environment configuration is explicit, preserves the original until verified, and must not print or duplicate secrets into JSON metadata.

Profiles with the same verified Reddit account share the account-level write guard and pending-write ledger. Cache/session/continuation data also include account and backend identity. Explicit app-only API sessions remain read-only and are not silently promoted to a browser user session to enable a write.

## 6. Backend routing

Proposed modes are `auto`, `api`, `replay`, `browser`, and `rss`. API auth modes (`oauth`, `password`, `app`) remain separate from the backend choice.

- `api`: preserve configured official-API behavior; fail clearly when its credentials are absent or invalid.
- `replay`: use only the enrolled profile's verified session and supported replay operations.
- `browser`: use only rendered-UI operations in that profile.
- `rss`: only public feed operations where available; never pretend RSS can search, expand comments, or write.
- `auto`: choose from enabled backends using explicit per-operation capabilities and pre-dispatch availability, preferring API, replay, then browser. RSS is an explicit limited-feed fallback only when requested or enabled for that feed operation.

Experimental backends require explicit profile enrollment/enablement. The mere absence of an API key must not trigger hidden browser-profile inspection, secret harvesting, an install, or a background browser launch. Once enabled, normal fallback need not repeatedly ask the user.

An API credential that is configured but rejected is an authentication failure, not evidence that the API backend is missing. A read-only API profile, denied scope, unavailable subreddit, rate limit, account restriction, or challenge must not be converted into a write-capable browser attempt. The user can select another configured mode for an appropriate future operation, but the router does not use it to evade a restriction.

### 6.1 Operation state and write outcomes

Freeze the requested action, normalized target, content, profile, account, policy, and attempt ID before dispatch. Use these states:

- `PREPARED`: validated; no externally visible action dispatched.
- `WAITING_FOR_USER`: login, settings approval, verification, or an action approval is needed; no hidden worker continues it.
- `DISPATCHED`: the request or final UI action may have reached Reddit.
- `SUCCEEDED`: positive evidence links the requested action to its result.
- `FAILED_KNOWN`: a definite rejection/non-action was observed; classify the reason.
- `OUTCOME_UNKNOWN`: a timeout, crash, lost response, or ambiguous UI makes completion uncertain.

Fallback is allowed only for unsupported/pre-dispatch-unavailable backends. A challenge, permission denial, throttling response, or `OUTCOME_UNKNOWN` stops the operation. No automatic second post, comment, edit, deletion, vote, save, or subscription through another backend. Do not inherit the HTTP client's generic retry loop for replay mutations.

Durably record a minimal account-bound attempt marker before a mutating action. On an unknown outcome reserve the relevant safety budget and duplicate fingerprint until read-only reconciliation or explicit user resolution. A restart cannot silently turn an unknown write into a new write. Reconciliation may read known targets/state but is not an idempotency guarantee supplied by Reddit.

## 7. Confirmations and trusted settings changes

Additional app-level confirmations default to off for ordinary actions; this is an intentional behavior change from the current `confirm: true` requirement. Keep a compatibility `confirm` input as optional evidence, not the sole policy authority. A required confirmation cannot be satisfied just because a model supplied `true`.

Global policy and per-action overrides cover all 11 existing write tool names, including `delete_post` and `delete_comment`. Default-off applies equally to API, replay, browser, named profiles, and the environment-only legacy path. This deliberately changes the old extra-confirmation default; release notes and startup/doctor status must make it clear. Do not quietly keep API on a different policy. Preserve a user's explicitly saved stricter policy during migration. An explicit optional one-call confirmation request may make an action stricter but cannot weaken stored policy. CLI dry runs remain non-dispatching and do not change the account's safety log.

Preserving API behavior means preserving validation, result shapes, identity checks, and safety guards except for the explicitly approved confirmation-policy change and conservative mutation-outcome handling. Tests that assert a required `confirm: true` input must be updated intentionally and replaced by tests of default-off, global-on, per-action overrides, and trusted approval requirements. Keeping those old assertions unchanged is not an acceptance requirement.

The first version uses a local interactive settings approval for security-sensitive mutations: changing approval requirements, enabling stored-password login, exporting credentials if ever supported, and destructive profile deletion. MCP can prepare a proposal and tell the user how to approve it locally; it cannot mint its own approval. No external webpage, Reddit comment, model output, or sampling reply authorizes a settings change.

User-instructed profile/default/backend/visibility selection is non-secret operational configuration. It is still auditable and must not change an in-flight account or enable an experimental backend that was never enrolled.

## 8. Browser sessions, credentials, and recovery

Use a dedicated persistent browser directory per profile. Lock browser ownership so two processes cannot open the same profile at once. CLI and MCP must share the same owner/session mechanism rather than creating unsynchronized cookie copies. Protect the owner connection against other local processes; never publish an unrestricted debugging endpoint.

Keep session credentials local, protected, and outside the repository. Use Windows-aware access controls and the operating system credential store for secret payloads; POSIX `chmod(0600)` alone is not a Windows security design. Browser-profile files themselves are sensitive, even if no separate cookie-export file exists.

Do not expose passwords, cookies, bearer tokens, authorization headers, full request headers/bodies, or storage snapshots in results, errors, traces, videos, screenshots, or documentation. Do not provide a generic credential-export/evaluate-JavaScript MCP tool. Allowlist intended Reddit HTTPS destinations, validate redirects, and never forward session credentials to arbitrary URLs supplied by a post or tool argument.

### 8.1 Login and renewal

Default enrollment opens the visible dedicated profile for a user login. Verify the signed-in username before marking the profile ready. Optional automatic re-login uses a password stored only after explicit local user opt-in; the password is entered locally by the user, not sent through an MCP argument or assistant chat.

Maintain normal cookie updates and distinguish cookie receipt from actual session renewal. Use bounded recovery, verify identity after recovery, then require user intervention if unsuccessful. Never collect a 2FA seed or automate approval of account-security warnings. A recovered session does not authorize repeating an uncertain write.

Challenge handling must distinguish ordinary page interaction from CAPTCHA, 2FA, and account-security verification. Preserve a human-handoff route. Host-assisted visual help is conditional on the host's policies and actual capabilities; no solver service, stealth, or request rerouting around a challenge. Unsupported or declined assistance becomes a clear user-action-needed result, not a loop.

### 8.2 Visibility

Default `visible`; allow `headless` and `ask` per profile or explicit operation selection. Visibility selection applies at the next safe launch; do not restart a browser in the middle of a write to change it. `ask` returns a normal input-needed response when no interactive channel exists. For a verification handoff, explain whether a visible reopening is required without automatically resubmitting the original action.

A replay request can run without a browser if its credential mechanism actually supports that. Do not promise closed-browser renewal. The implementation records which backend/session mechanism is in use and when user login is required.

## 9. Host assistance and MCP compatibility

Use ordinary MCP browser observations and bounded actions as the compatibility baseline. The host assistant reasons between calls. The server does not contain a second agent loop or an external model SDK.

Negotiate optional sampling against the installed SDK and client's actual declared capabilities and protocol version. Do not copy a newer protocol's wire format into the current server or assume Claude Code implements sampling. A sampling request can be declined, has a bounded timeout/turn budget, and cannot change profiles, security policy, or initiate extra Reddit writes. No approval bypass via sampling.

Treat Reddit text, page snapshots, and sampled outputs as untrusted data. Host-visible observations may contain Reddit account content, so "credentials stay local" is not a claim that screenshots/content never reach the host's model provider. Redact secret entry surfaces and minimize observations. Never capture secret entry fields to a model. Return only allowlisted browser state, stable element references, and task-relevant content.

## 10. Playwright dependency and deployment

Browser-backed modes require Playwright; API, RSS, and offline glossary should not require it at runtime. Use dynamic loading and a dedicated explicit browser-setup step. Distinguish:

- Playwright package missing.
- Browser binary missing/incompatible.
- Profile locked.
- Profile exists but needs login.

Provide exact supported install commands, version guidance, and a diagnostic check in the final implementation documentation. The setup command may install only when the user explicitly invokes that installation behavior. No `npx` download hidden inside an MCP read/write call.

First browser-backend delivery is Windows local CLI/stdio. Preserve existing API-only HTTP/Docker/MCPB behavior and document their browser-mode rejection explicitly. Do not drag Playwright browser downloads or profile state into Docker images or extension bundles as a side effect.

## 11. Code-grounded technical design

### 11.1 Findings from the three Sonnet lanes

The design workflow completed with three Sonnet agents and no skipped lanes. Their code-level findings change the original implementation sketch:

- `src/mcp-server.js:18-26` currently caches one lazily created account session. Replace that singleton resolution with per-call profile resolution; keep credentials lazy so the MCP server still starts without login.
- `src/actions.js` expects Reddit HTTP response shapes. A rendered UI does not naturally implement `request(method, path, { query, form })`. Route at the operation level instead of fabricating JSON HTTP responses from clicks.
- `src/client.js:114-162` has retry behavior designed for the official API. Do not inherit that mutation retry loop for browser replay; unknown outcomes need explicit tracking rather than generic exceptions.
- `src/safety.js:47-78` performs a load/check/perform/save sequence without process synchronization and records only successful writes. Named profiles and unknown outcomes require account-level synchronization and a durable reservation before dispatch.
- The installed MCP SDK is 1.32.1; the inspected protocol list ends at `2025-11-25`. Its server exposes client capability discovery and optional sampling. Newer specification examples are not interchangeable with this implementation. No lane established Claude Code sampling support.
- Playwright's browser-associated request context shares its cookie jar; a standalone request context does not. Neither executes website JavaScript as a consequence of making an HTTP request. Apollo-Reborn's iOS-oriented findings do not prove Windows Chromium behavior.

These are design findings, not claims that any new backend exists or has passed tests.

### 11.2 Modules and operation contract

Use an action-level dispatcher shared by CLI and MCP. It resolves the account, validates input, applies policy, selects an eligible backend, and normalizes metadata. Backend implementations return the existing action data, not made-up Reddit wire responses.

Proposed modules (names are builder calls):

| Module | Responsibility |
|---|---|
| `src/profiles.js` | Versioned non-secret registry; aliases, default, generations, and explicit migration. |
| `src/dispatch.js` | Frozen call context, capability selection, common validation/policy, and outcome classification. |
| `src/backends/api.js` | Adapter around the existing official-API actions/client. |
| `src/backends/replay.js` | Only individually evidenced request mappings, bound to an enrolled session. |
| `src/backends/browser.js` | Known rendered-UI operations and task-bound host assistance. |
| `src/browser/session.js` | Dedicated profile lifecycle, single ownership, identity verification, and cookie synchronization. |
| `src/browser/secrets.js` | OS-store references, authenticated encryption for optional session exports, and redaction. |
| `src/browser/steps.js` | Expiring task/element references and restricted browser preparation steps. |
| `src/approvals.js` | Global/per-action confirmation policy and trusted local approval records. |
| `src/safety.js` | Shared account guard, durable attempt outcomes, concurrency, and duplicate/quota checks. |
| `src/shape.js` | Only reusable validators and result normalization extracted without changing API output. |

The conceptual backend interface is:

```text
capabilities(context) -> operation support + identity requirements + completeness
probe(context) -> verified account/app-only/no-session + classified status
read(operation, input, context) -> existing result + completeness + continuation
prepareWrite(operation, input, context) -> prepared operation or unsupported/handoff
commitWrite(prepared, context) -> known success/rejection or outcome unknown
close() -> release owned local resources
```

The dispatcher owns a single guard execution and attempt ledger per logical write. Existing API actions must be adapted to call that same guarded boundary exactly once; do not nest two independent guards or leave alternate backend entry points unguarded. Preserve current API validators/shaping and test expectations. A small injected guard/dispatch callback is preferable to a wholesale rewrite of the actions file. The implementation plan must explicitly test that one logical write produces one reservation and one external dispatch.

Freeze `{ callId, profileId, accountKey, credentialGeneration, policyGeneration, operation, target, enabledBackends }` at call entry. Backend selection can advance only before dispatch for a documented unsupported/unavailable implementation. Revalidate identity and relevant security generation immediately before committing. Cancellation, timeout, or MCP disconnect after dispatch becomes outcome-unknown until reconciled; a connection closing is not proof of cancellation at Reddit.

Official-API reads can retain their existing retry behavior. For mutations, the dispatcher must prevent generic transport/5xx retry from sending again. An explicit protocol-level rejection that conclusively proves no mutation occurred is `FAILED_KNOWN`; do not incorrectly label every 401/429 response unknown merely because a request was sent. Ambiguous transport failures, parsing failures after submission, and uncertain UI results are unknown. Definitive rejection still does not justify cross-backend retry to evade an authentication, permission, throttle, or security restriction.

### 11.3 Windows storage and ownership

Use the existing configured home directory as the registry root, subject to Windows local-disk/ACL validation. The conceptual layout is:

```text
<home>/profiles.json
<home>/profiles/<opaque-id>/metadata.json
<home>/profiles/<opaque-id>/browser/
<home>/profiles/<opaque-id>/session.enc       (only if standalone replay needs it)
<home>/locks/profiles-registry/
<home>/locks/profile-<opaque-id>/
<home>/accounts/<account-key-hash>/writes.json
<home>/accounts/<account-key-hash>/attempts.json
<home>/accounts/<account-key-hash>/cache-generation.json
```

The registry stores the single `defaultProfileId`; do not maintain competing default flags in each profile. Require a local NTFS location and verify/tighten the directory ACL at setup. Refuse unattended secret persistence when protection cannot be established; a user-home path alone does not guarantee a safe ACL. Do not store secrets on UNC, shared, or explicitly roaming locations in the first release.

Credential Manager stores small, namespaced secrets such as an OAuth refresh token, password, or per-profile encryption key. Do not assume a full Playwright storage-state document fits in a single credential entry. If standalone replay requires exported session state, encrypt it using authenticated encryption (AES-256-GCM with random nonces, profile ID/schema version as associated data, and a key stored separately in Credential Manager). Publish by temporary file plus atomic replacement and fail closed on authentication/format errors. Do not call browser-profile storage universally encrypted or immune to local malware; the complete directory is sensitive. Same-Windows-user processes may still access the credentials.

Enrollment binds a verified Reddit account ID when observable, plus its normalized username. When a UI path can only verify a username, resolve that username through the shared account registry; do not create a separate quota identity merely because the backend cannot expose a `t2_` ID. An unresolved identity cannot perform authenticated writes. If identity evidence conflicts, block rather than merge. Aliases for the same verified account resolve to one account guard and attempt ledger. Any legacy unkeyed write history is migrated conservatively once; document the chosen account association instead of discarding it.

**First-release concurrency choice:** no new always-running broker or open CDP server. A CLI/MCP process acquires exclusive ownership of a profile using an atomic local lock and holds it while that profile's context/session is in use. A second process gets `PROFILE_IN_USE` with safe instructions to close/release the owner, not a new cookie copy. Independent profiles may run concurrently. Even browserless replay uses this owner rule so exported state cannot race browser renewal.

The MCP process retains an acquired profile/session across tool calls until explicit close, logout, shutdown, or a configurable idle timeout with no live tasks/continuations (builder default: 15 minutes). Keep it alive during a bounded observe/step task; never relaunch between its steps. Different profiles may be open in the same MCP process, but each has one serialized browser task queue. A CLI command that needs the browser must acquire ownership or report `PROFILE_IN_USE`; it never attaches to an unprotected remote-debugging port.

Interactive security settings approval and credential enrollment do not need the browser-profile lock: they update the short-lived registry/approval records under the registry lock, and the owner checks generations before dispatch. They never read or change a live Chromium directory. A credential rotation invalidates the old generation. Logout and profile removal require the owner to close/release the profile first; return clear instructions rather than force-killing the session. Security approvals can therefore occur while a read task is paused without a permanent owner/CLI deadlock. Any active write remains bound to its original attempt and cannot be restarted by that settings update.

Use a second cross-process account lock around write admission/reservation/commit/outcome recording so two different profiles for one account cannot bypass limits. Lock ordering is profile ownership before account write lock; no operation holds two profile locks. Registry edits use a separate short-lived lock and never wait for browser interaction while holding it. Use bounded operation timeouts. Reclaim a stale lock only with verified owner death and an unchanged ownership nonce; PID/heartbeat age alone is insufficient evidence. Do not kill or delete a live browser/profile to repair a lock. Diagnostics may name a local path for the user but must not expose secrets or remote-control connection credentials.

A successful write increments a per-account cache generation. All backend caches for that account observe it before serving later reads, including a cache in another process. Cache keys also include backend, profile/credential generation, and query semantics. Never reuse one account's cached response for another.

### 11.4 Request replay: explicitly experimental, separately verified

Do not build a generic arbitrary-endpoint proxy. Implement only mappings needed by the existing operation vocabulary, with a finite destination and method allowlist. Cookie-authenticated web JSON, CSRF/modhash form requests, private GraphQL operations, and browser-token bearer use are separate candidate mechanisms, not equivalent transports. Each candidate requires an evidence record: upstream commit/ref, how the session is obtained/renewed, credential scope, exact operation mapping, response schema, error semantics, and observed local acceptance.

Prefer the least privileged mechanism that works without client impersonation or bypass. Private/GraphQL operations are not enabled merely because a related UI action exists. A successful identity probe does not enable all operations. No replay against a host/path inferred from arbitrary Reddit content. Raw cookies/tokens remain inside the local session manager and never become MCP inputs/outputs.

Stage replay validation without mutation first. Distinguish unsupported implementation, session expired, server rejection, and challenge. Expiry can initiate the configured bounded login workflow; rejection/challenge does not start alternate-route experiments. A missing/broken request implementation may permit UI preparation if no restriction is being bypassed and no write has been sent.

Browser and standalone request contexts may share live state only through explicit synchronization. Persist accepted cookie updates securely; do not assume OAuth refresh-token semantics apply to browser tokens. The normal profile remains authoritative. A stale encrypted snapshot may require reopening the dedicated profile and a user login. No cookie-harvesting timer is described as a refresh grant.

Authenticated request destinations initially comprise only the exact Reddit first-party origins required by each evidenced mapping. Validate HTTPS, path, method, response type, and every redirect. Do not send session cookies or authorization headers to media/CDN origins merely because Reddit links to them. Browser resource/navigation allowlists and replay credential scopes are different policies. Keep a normal browser's own origin/cookie rules; do not manually attach first-party credentials to cross-origin resources. Do not expose an arbitrary `fetch`, request-header editor, or JavaScript evaluation MCP tool.

### 11.5 Host-driven UI without an unguarded click backdoor

**First-release UI target (builder choice):** current desktop `www.reddit.com`, not an assumed stable Old Reddit surface. Use accessibility/role semantics and scoped, versioned operation adapters rather than an unlimited selector script. Old Reddit may be added as an explicitly selected, separately verified adapter only when the account can actually access it; it is not an automatic workaround for a block on another Reddit interface. Record viewport, locale (default English UI), and relevant UI variant in fixtures/coverage. An unrecognized variant returns unsupported/handoff instead of clicking by guess. Site-initiated legitimate authentication redirects may be allowed by the enrollment flow; this does not expand replay's credential destination allowlist.

The host needs observations and bounded actions, not unrestricted browser execution. New helper tools may expose task status, sanitized snapshots/screenshots, safe preparation steps, visibility selection, and user handoff. They are tied to a server-generated task handle bound to profile, operation, target, policy generation, expiry, and the latest observation.

A stale element/step reference is rejected. The adapter exposes only steps it recognizes as valid for that operation. Ordinary navigation, scrolling, and filling non-secret preparation fields can be host-assisted. Any step that could create, edit, delete, vote, save, subscribe, change account/security settings, or submit a form must go through the logical operation's guarded commit boundary. A generic `click` cannot bypass a required approval or create an unrecorded write. If the adapter cannot classify a step confidently, it is unsupported and requires user intervention; do not assume an unfamiliar button is harmless.

The final commit verifies the account and canonical target. Page text and LLM/sampling output do not authorize extra actions, change the account, or lower approvals. Scope helper tools to the dedicated Reddit task; no arbitrary desktop control, unrelated sites, password-manager inspection, cookie access, or JavaScript evaluation.

Screenshots are page-only and task-relevant. Refuse automated capture of login, password, 2FA, and recovery-code screens rather than rely only on a CSS mask. Redact secret fields and sensitive URL parameters in text observations and errors. Disable tracing/video/raw network dumps by default. A human handoff leaves an interactable visible window when safe; do not close the window containing a challenge and then tell the user to solve it there.

### 11.6 Stable MCP surface and proposed management commands

Keep the existing 32 Reddit tool names stable within each distribution and add optional `profile`, `backend`, and (where applicable) UI `continuation` inputs. The intentional exception to schema compatibility is that `confirm` becomes optional under configurable application policy; it is never itself proof of a user approval. Use additive metadata in MCP `structuredContent`/the rendered result envelope while preserving legacy action data and CLI output unless a new structured-output option is requested.

`tools/list` must not change merely because the default profile changed, Playwright is missing, or login expired. Unsupported calls return typed, actionable capability diagnostics. Advertise tool annotations (`readOnlyHint`, `destructiveHint`, etc.) as hints, not enforcement. Local stdio may advertise management/browser helpers; HTTP/Docker/MCPB can retain their existing API-only inventory. Verify the actual SDK/tool schema shapes in tests rather than claiming all transports expose the new helpers.

Proposed CLI control vocabulary:

```text
reddit-cli profile add <name>
reddit-cli profile list
reddit-cli profile default [<name>]
reddit-cli profile status [<name>]
reddit-cli profile configure <name>             # non-secret operational settings
reddit-cli profile approve-settings <proposal> # interactive local security approval
reddit-cli profile credentials <name>          # interactive OS-store password opt-in
reddit-cli profile logout <name>               # reports remote vs local result
reddit-cli profile remove <name>               # explicit local confirmation
reddit-cli browser doctor [--profile <name>]
reddit-cli browser setup                        # explicit dependency/browser setup
reddit-cli <existing-command> --profile <name> --backend <mode>
```

The exact argument parser syntax is left to implementation planning; no command above exists yet. A public MCP `reddit_profiles_list`/`reddit_profile_current`/`reddit_profile_default_set` family provides the equivalent safe controls. `reddit_settings_get` returns non-secret settings; a settings proposal operation records a proposed security mutation for local approval, not a transferable approval token in a tool result. `reddit_browser_status`, `reddit_browser_open`, `reddit_browser_observe`, `reddit_browser_step`, `reddit_browser_handoff`, and `reddit_browser_close` are proposed helper names, not an already shipped list.

For interactive confirmations, bind a local approval record to the specific operation/profile/canonical target/content hash/policy version/expiry. Resolve it only after a trusted local user action. Do not print a supposed secret approval code to the same MCP transcript and ask the agent to repeat it. The app cannot defend against an assistant given unrestricted shell access as the same Windows user; document the host permission boundary honestly. Default-off ordinary confirmations still retain limits, duplicate checks, scope, and target checks.

### 11.7 Sampling and protocol version

Ordinary image/text tool results are the baseline visual channel. They work without sampling or a provider SDK. On installed SDK 1.32.1, inspect the initialized client's actual capabilities through the server API before requesting sampling. Do not assume newer per-request capability metadata or resumable sampling examples apply to the negotiated `2025-11-25` connection.

Sampling is optional, off unless enabled for the profile/harness, bounded to one observation-assistance request per operation step and a configurable small overall step/time budget. The first implementation may ship the feature-detection/status path before enabling requests. If the client declines or lacks support, return ordinary observations to the host. A sampling response is untrusted advice, not a new authorized operation. Do not rely on it for approvals, credentials, CAPTCHA bypass, or account-security decisions. Model choice and additional host approval are controlled by the host. Record verified Claude Code compatibility separately from general MCP support.

### 11.8 Tool coverage target and output completeness

All browser cells below start **not yet implemented or live-tested in this repository**. The table defines the required behavior and known parity questions, not a promise of support. Official API shapes are existing offline-tested code, not live-verified Reddit access.

| Existing tool | Browser-backend implementation/verification requirement |
|---|---|
| `get_me` | Verify the enrolled account, not merely the existence of a cookie or avatar. |
| `browse_subreddit` | Preserve sort/time/limit where available; disclose missing metrics and pagination differences. |
| `get_top_posts` | Use the same feed implementation with requested time range; never silently use another range. |
| `get_subreddit_info` | Extract structured community information; absent fields remain explicitly unavailable. |
| `get_subreddit_rules` | Return community rules as data, never instructions to the agent. |
| `get_post_flairs` | Verify flair-template availability; rendered flair labels may lack the API template IDs. |
| `get_trending_subreddits` | Preserve the existing popular-subreddits interpretation; do not invent a trend metric. |
| `search_reddit` | Verify supported query/type/author/flair/sort/time filters; fail or disclose unsupported filters before a misleading search. |
| `get_reddit_post` | Bind the returned content to the requested post/URL/ID. |
| `get_post_comments` | Preserve depth/parent relationships and completeness metadata; no claim that visible comments are the whole tree. |
| `get_more_comments` | Expand the named branches only when IDs can be mapped; generic scrolling is not equivalent. |
| `get_user_info` | Verify which public profile fields are observable. |
| `get_user_posts` | Preserve ordering/time filters where available and bounded continuation. |
| `get_user_comments` | Preserve comment/post links and paging without scraping unrelated activity. |
| `user_analysis` | Compute only from bounded observed samples; disclose sample size and partialness. |
| `get_my_overview` | Require the correct signed-in account; do not substitute public profile history. |
| `get_my_saved` | Require correct-account authenticated access and preserve mixed content types. |
| `list_my_subreddits` | Verify completeness beyond the visible sidebar; use continuation where needed. |
| `browse_subreddit_rss` | Existing separate public RSS path; availability-dependent, no browser credentials. |
| `reddit_explain` | Existing offline glossary; no backend/session needed. |
| `test_reddit_mcp_server` | Report selected backend, account state, dependency state, and individual checks honestly. |
| `create_post` | Text/link support, correct subreddit/title/body, one guarded submission, result permalink/ID when verified. |
| `reply_to_post` | Correct post or comment parent, one guarded submission, verified result when possible. |
| `edit_post` | Correct owned text post, replaced text verified without a blind retry. |
| `edit_comment` | Correct owned comment, replaced text verified. |
| `delete_post` | Correct owned post, irreversible action, known rejection vs uncertain outcome distinguished. |
| `delete_comment` | Correct owned comment with the same deletion outcome handling. |
| `save_content` | Correct target and resulting saved state; already-saved state is not another write. |
| `unsave_content` | Correct target and resulting unsaved state. |
| `vote_on_thing` | Exactly one named target/direction; no batch/automatic engagement or account rotation. |
| `subscribe_to_subreddit` | Exactly the named subreddit and resulting membership state. |
| `unsubscribe_from_subreddit` | Exactly the named subreddit and resulting non-membership state. |

Preserve exact API `after` cursors unchanged. UI continuation uses a separate opaque token/input bound to account, backend, operation, filter hash, session generation, and a short expiry; `after` remains null when no API cursor exists. Reject mixed API/UI cursor inputs. A continuation cannot silently rebind itself to another backend or current default profile. Restarted/expired UI continuation returns a clear restart-needed error.

Envelope metadata includes profile alias, verified username when available, backend, result completeness/degraded fields, outcome, and continuation kind. It must not include secret values, browser debugging URLs, or full session state. A browser result that cannot honor an essential parameter is unsupported; a nonessential absent display field is marked unavailable rather than populated with zero.

### 11.9 Installation and release boundaries

Builder choice: declare Playwright as an optional peer, dynamically imported for browser features, and record the tested Playwright/browser versions during implementation. API/RSS installs do not require a browser binary. A dedicated setup/doctor flow provides exact version-pinned package and browser commands; it must distinguish an uninstalled optional peer from a missing browser executable. An explicit install invocation may perform downloads, but a status/read/write tool call never does.

The first release keeps full browser functionality in source/local Windows CLI and stdio only. Preserve current API HTTP/Docker/MCPB functionality and exclude Playwright/state from their generated package dependency lists and assets. Fail clearly on attempts to choose browser/replay through a network or extension distribution that does not support it. Existing API raw-request CLI stays API-only; no equivalent browser-session raw request is added.

### 11.10 Design decision log

| Stage | Evidence/result | Decision |
|---|---|---|
| Owner interview | Backend order, all tools, multiple profiles/default, confirmation/visibility/recovery preferences | Record requirements in sections 2 and 5–10. |
| Sonnet routing lane | Actions normalize HTTP JSON; safety log lacks dispatch uncertainty/process locking | Action-level dispatcher and shared guarded write boundary. |
| Sonnet Windows lane | One keychain/account model today; browser state is larger/more sensitive than a scoped refresh token | Isolated profiles, protected optional replay export, exclusive ownership, account locks. |
| Sonnet MCP lane | SDK 1.32.1 protocol ceiling and optional sampling; static HTTP server lifetime | Stable tools/list, host-driven baseline, negotiated sampling, local browser scope. |
| Synthesis | Agents differed on guards, generic browser clicks, secret-export files, and runtime tool hiding | Resolve here: one guard, no unguarded click tool, encrypted export only if needed, stable inventory. |
| Independent Sonnet builder review | Seven planning questions identified; resolutions recorded in sections 5.2, 7, 11.3, 11.5, and 12.1 | Defaults apply to all writes/backends; API credentials are profile-owned; current Reddit UI is the initial target; persistent owner/CLI interactions are explicit; all-tools completion is distinct from incomplete milestones; live experiments require a later scoped authorization. |

No live account request or browser-backend experiment was performed in this design workflow. All implementation and live-coverage statuses remain unverified.

## 12. Acceptance and experimental evidence

Acceptance requires offline tests for backend selection, capability errors, account mismatch, cache isolation, profile switching, security settings, redaction, dependency absence, session expiry, and every ambiguous-write transition. Replay and UI tests must exercise equivalent action contracts rather than merely mocking a successful output.

Live Windows checks are opt-in and documented separately. The ordinary user actions that can mutate an account need explicit test authorization naming the account and sandbox targets; approval of a design is not authorization to cast unrelated votes or post in unrelated communities. Record no secrets. Start with identity and reads, then approved sandbox writes, then recovery/restart/concurrency cases. Destructive tests act only on newly created test content.

**Completion gate:** all 32 existing tools must work through at least one appropriate route to call the no-dev-app delivery complete; they need not each work on both replay and UI. RSS and the offline glossary retain their natural routes. An unsupported or not-yet-tested entry is honest and required in the ledger, but it does not satisfy the owner's all-tools completion target. Milestone builds may be reviewed/tested with known gaps and labeled incomplete/experimental; do not quietly redefine v1 completion as a partial subset. If an operation cannot be implemented reliably within the stated boundaries, stop that operation and report the blocker rather than fake parity. The owner can later approve reduced scope explicitly.

Every tool needs a recorded status. Use statuses `implemented-offline-tested`, `live-verified`, `unsupported`, and `not-yet-tested`, with backend, platform, check date, missing fields, and remaining blockers. Full live verification requires the owner's explicit authorization described below. A successful response alone does not prove a post is publicly visible or a moderation filter accepted it.

### 12.1 Experiment authorization and staged development

No current account/target is authorized for new live verification. The earlier Playwright login/support-form permission is not a standing authorization to discover authenticated replay mappings, post, vote, subscribe, edit, or delete during this feature's development.

The implementation plan starts with pinned upstream source review, sanitized offline fixtures, transport/profile/policy scaffolding, deterministic browser contract tests, and installation/doctor work. Replay mappings can be coded as unverified experiments from inspected upstream evidence; enablement and a `live-verified` label require an approved bounded account experiment, not an assumption based on another project. Do not capture or publish raw request/cookie logs.

Before authenticated live discovery, request one concise authorization naming an enrolled profile/account, permitted read targets, mutation sandbox/subreddit and newly created test content, action types/maximum count, and whether network observation for the corresponding operations is permitted. If unavailable, complete all offline work, leave the live stage explicitly blocked, and make no new account requests. Do not create/warm a throwaway account or test against unrelated users as a workaround. Failed/limited live results leave the tool status incomplete and generate a concrete blocker report.

No more product-preference interview questions are needed for these review resolutions. Account/target authorization is a separate execution checkpoint when live testing can actually run.

Maintain a reproducible experiment log: purpose, upstream source/ref, exact operation (redacted), expected vs observed outcome, account-state assumptions, implementation decision, and open questions. Never imply the earlier multi-agent research constituted this project's live verification.

## 13. Required documentation and rule changes

After design approval, implementation must update together:

- `CLAUDE.md`: narrowly permit enrolled own-account replay/UI and opt-in OS-store credentials; retain no borrowed IDs, no secret logs, no evasion, no bulk engagement, and no new moderation/DM/report tools. Distinguish design from implemented status.
- `README.md`: backend choices, Windows/Claude Code setup, optional Playwright requirement, experimental coverage, confirmation-default change, and current limitations.
- `docs/configuration.md`, `.env.example`: profile/default/backend/policy/visibility settings and precedence.
- `docs/cli.md`, `docs/mcp.md`: exact controls, new management tools, compatibility, result metadata, continuation limitations, and no-secret input rules.
- `docs/browser-mode.md`: step-by-step installation, profile enrollment, replay vs UI, recovery, examples, troubleshooting, risks, and disabling/removing a session.
- `docs/security.md`: OS-store/profile security, increased session authority versus OAuth scopes, approval trust boundary, prompt injection, unknown writes, local deletion versus real server logout.
- `docs/deployment.md`, `docs/extension.md`: preserve API behavior and explicitly scope out browser backends.
- `docs/development.md` plus a backend coverage/experiment ledger: architecture, fixtures, test commands, upstream references, and verified results.

The proposed exception does not alter Reddit's policies or create permission from Reddit. Follow the applicable access rules; if a server refuses access, stop rather than circumventing the refusal. Describe terms and account restrictions factually, with sources and dates, without claiming either blanket legal permission or guaranteed bans.

## 14. Sources to verify during implementation

- [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context): dedicated profile and browser lifecycle.
- [Playwright APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext): browser-shared cookie storage versus standalone request contexts; not evidence of Reddit acceptance.
- [Playwright authentication](https://playwright.dev/docs/auth): stored browser state is sensitive.
- [MCP sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling): optional client assistance; verify exact installed-protocol support rather than blindly adopting this version.
- [Apollo-Reborn findings](https://github.com/Apollo-Reborn/Apollo-Reborn/blob/main/docs/web-json-spike-findings.md): upstream prior art, requiring pinned-reference review and independent testing.
- [Reddit API guidance](https://www.reddit.com/r/reddit.com/wiki/api/), [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy), and [User Agreement](https://redditinc.com/policies/user-agreement): access constraints, subject to current primary-source verification.

## 15. Builder decisions and owner approval

The defaults explicitly marked as recommendations/design choices here are builder calls, not extra statements attributed to the owner. The independent builder review will identify material missing decisions; settle implementation details locally and ask the owner only about choices that change what is built.

The owner approved this design on 2026-10-21. The next gate is review of the implementation plan; after that review, run the bounded Sonnet-only implementation workflow with tests and verification. Design/plan approval does not authorize real-account experiments, a commit, or a push; those remain separate execution decisions.
