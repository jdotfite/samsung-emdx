**Findings**
1. The new send-progress modal is still simulated on the client, not driven by real backend milestones. That means the UI can show “Waking displays” or “Refreshing display” even if the backend is already ahead, stalled, or failed for a different reason. This is the biggest trust gap in the current app. See [app.js](/C:/_websites/poster-creator/src/app.js#L8), [app.js](/C:/_websites/poster-creator/src/app.js#L430), [app.js](/C:/_websites/poster-creator/src/app.js#L755), [app.js](/C:/_websites/poster-creator/src/app.js#L1365).

2. The delivery path now always does `wake -> wait -> send -> wait -> resend` whenever a MAC is present. It works, but it doubles every send and hides whether the first send was actually needed or successful. That will become expensive and hard to reason about once you have more displays or schedules. See [send-service.mjs](/C:/_websites/poster-creator/scripts/lib/send-service.mjs#L26).

3. “Enabled” is enforced in the UI but not in the backend send route. The Content screen hides disabled devices, but `/api/content/send` will still send to any stored screen id if posted directly. That inconsistency will matter once you add automations, groups, or sharing. See [app.js](/C:/_websites/poster-creator/src/app.js#L954) and [app.mjs](/C:/_websites/poster-creator/server/app.mjs#L214).

4. There is still no persisted content-assignment model. The app stores only “last image sent” preview state, not “this device is assigned to this content item/source/profile.” That blocks reliable scheduling, rebroadcast, and future music/movie/profile separation. See [device-state-store.mjs](/C:/_websites/poster-creator/server/device-state-store.mjs#L27).

5. The codebase and docs are still split between the old poster-wall architecture and the newer device/content/studio product. The README is outdated, and `src/app.js` is carrying device UI, content UI, studio import, poster rendering, send flow, and legacy hooks in one file. That is the main maintainability risk now. See [README.md](/C:/_websites/poster-creator/README.md#L101), [app.js](/C:/_websites/poster-creator/src/app.js#L1), [app.js](/C:/_websites/poster-creator/src/app.js#L1112).

**Current State**
The project is past prototype stage. Device wake/status/send works, uploaded images can be sent from the UI, and the app now has the right top-level product split: `Devices`, `Content`, `Studio`.

Where it is weak is model clarity:
- devices exist, but assignments do not
- content exists, but as files rather than first-class records
- studio exists, but it is still partly mixed with the old poster engine
- send UX exists, but its progress is inferred rather than real

**Plan**
1. Build a real send job model.
Use SQLite-backed `send_jobs` and `send_job_targets`, return a `jobId` from `POST /api/content/send`, and have the modal poll `/api/send-jobs/:id`. Stages should be real: `queued`, `waking`, `sending`, `verifying`, `completed`, `failed`. This should be the next change.

2. Add first-class content records.
Create a `contents` table for uploaded/generated assets with fields like `id`, `title`, `type`, `path`, `thumbnail`, `source`, `created_at`. Then add `device_assignments` so a device can be assigned content independently of the most recent send.

3. Separate ephemeral send from assignment.
On Content, make the actions explicit:
- `Send Now`
- `Assign to Device`
Later:
- `Assign and Send`
That clears up what “current content” means on the Devices page.

4. Tighten the device model.
Replace the vague `enabled` flag with something like:
- `visible`
- `sendEnabled`
- later `group`
Also enforce send eligibility in the backend, not just the UI.

5. Split the frontend by section.
Break [app.js](/C:/_websites/poster-creator/src/app.js#L1) into:
- `devices-view.js`
- `content-view.js`
- `studio-view.js`
- `send-flow.js`
- `device-modal.js`
This is the point where future work gets easier instead of harder.

6. Move poster generation fully into Studio.
Keep Devices and Content operationally simple. Studio should own:
- Spotify import
- playlist-to-album workflows
- poster template selection
- future movie poster generation

7. Update the docs to match reality.
The README should describe the current product as a Samsung EMDX controller with content library, device inventory, and studio/generation workflows, not the original poster-wall tool.

**Recommended Order**
1. Real send jobs + modal polling
2. Content records + device assignments
3. Backend enforcement of device send state
4. Frontend file split
5. Studio refactor for Spotify/posters
6. README refresh

**Open Questions**
- Should `Send` also update the device’s assigned content, or stay purely temporary?
- Should Devices show disabled/offline frames by default, or only active ones?
- Do you want the next milestone to focus on reliability first, or on building the Studio workflows for playlists/artists?
