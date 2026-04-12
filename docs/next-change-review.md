**Current Product Review**

The app now has four real product surfaces:
- `Devices`: grouped by room and wall, with room/wall management
- `Content`: browse, collections, ordered sets, preview, edit, send, and scheduling
- `Studio`: Spotify-driven source import and poster generation
- `Delivery`: wake/status/send job flow

The current bottleneck is no longer missing features at the top level. It is trust and consistency inside the Content workflow, especially edit mode.

**What Is Working**

1. Devices are now meaningfully organized by room and wall instead of a flat list.
2. Content has a real organization model: collections, sets, search, sort, preview, and send.
3. Studio supports album discovery/import and can generate posters into the shared Content library.
4. Toast messaging is in place, so errors and notices no longer need to consume vertical page space.
5. The send flow is a real product surface, not just a hidden background action.

**What Changed In This Pass**

1. Edit mode now targets one canonical Samsung frame spec instead of asking the user to choose a target frame.
2. Edit preview is now rendered through the backend image pipeline instead of mixing CSS-only preview behavior with save-time transforms.
3. Manual crop controls now exist directly in the edit modal:
   - zoom
   - horizontal position
   - vertical position
4. Vibrance is now part of the image recipe.
5. Closing the edit modal no longer relies on the browser-native unsaved-changes confirm for that flow.
6. Content search/sort and edit selects have had a consistency pass so they align more closely with the existing Spotify/workspace field language.
7. Content preview surfaces now render the saved edited result instead of always showing the original source image.
8. Ordered wall layouts now sit behind `Manage Library`, so normal browse mode stays focused on:
   - pick
   - preview
   - send
9. Creating a new ordered set now opens its layout editor immediately, which makes wall assignment the natural next step instead of a hidden follow-up action.
10. Content scheduling now exists for both:
   - single posters sent to selected frames
   - ordered wall layouts sent to their mapped wall
11. Automation now sits with manage mode so browse mode stays focused on immediate selection and send.

**What Is Still Not Yet Finished**

1. Edit mode is much closer to trustworthy now, but it still needs final UX shaping.
   The open question is not whether the transforms work.
   The open question is whether the control model is the cleanest one for users:
   - quick fit
   - manual crop
   - tone/detail

2. Ordered sets exist in the model and UI, but they still need stronger wall-aware workflow language.
   The foundation is now in place:
   - create ordered set
   - assign it to a wall
   - map each poster to left/center/right
   - send set to wall
   - schedule set to wall
   The next step is making that workflow even more obvious in the overall Content journey.

3. Content metadata is present, but not yet complete as a true media asset model.
   Resolution and orientation should be first-class.
   Edit state should be first-class.
   Display-prep state should be first-class.

**New Direction Confirmed**

The product only needs to support one canonical Samsung frame type.
That means edit mode should stop asking the user to choose a target screen when all enabled screens share the same intended output spec.
Editing should default to the canonical frame dimensions and preview exactly that result.

**Action Items**

**P0: Trust And Consistency**

1. Done: make edit mode target one canonical frame spec by default.
2. Done: replace the mixed CSS/server edit preview with a real rendered preview path.
3. In progress: surface image resolution, orientation, and format everywhere Content decisions are made.
4. Done for edit mode: replace browser-native unsaved-edit confirmation with a polished in-app confirmation.
5. In progress: restyle Content search and sort controls so they match the Spotify/workspace form language.
6. In progress: audit all dropdowns/selects in Content/Edit so they use the same visual system.
7. Next: verify that all preview surfaces use the same display-prep truth, not a mix of raw source and framed output.

**P1: Edit Mode Completion**

1. Done: add vibrance control.
2. Done: add free zoom for manual crop.
3. Done: add horizontal and vertical image positioning inside the canonical frame.
4. Done: clarify quick-fit presets versus manual crop mode in the edit UI.
5. Keep edit recipes non-destructive and saveable as either:
   - applied recipe on original asset
   - saved copy
6. Consider whether `invert` should stay hidden, move to an advanced section, or be removed entirely from the recipe.

**P1: Content Workflow Clarity**

1. Keep browse mode optimized for:
   - pick
   - preview
   - send
   Wall layouts should appear here only as a lightweight entry point back into management, not as the primary browse surface.
2. Keep manage mode optimized for:
   - multi-select
   - collection assignment
   - set creation
3. Keep edit mode optimized for:
   - image preparation for e-ink display
4. Keep automation optimized for:
   - timed single sends
   - timed wall layout sends
   - clear pause/resume/delete management

**P2: Sets And Wall Delivery**

1. In progress: improve set workflow language around triptychs and ordered wall layouts.
2. Done: add explicit left/center/right mapping in the set editor.
3. Done: add `Send Set to Wall` as a first-class action.
4. Done: add first-pass scheduling for single posters and ordered wall layouts.
5. Later connect that same model to Home Assistant / external automation.

**P2: Library Quality**

1. Add favorites or pinned content.
2. Add recently sent / recently edited views.
3. Add richer asset info in preview:
   - dimensions
   - file size
   - orientation
   - format
   - fit warning

**P3: Reliability And Maintainability**

1. Add Playwright coverage for:
   - Content browse/manage/edit flows
   - collection assignment
   - set creation
   - edit save/reset/cancel
2. Split the frontend by surface once the current Content flow is stabilized.
3. Refresh the README so it describes the current product accurately.

**Recommended Next Slice**

1. Finish the control model for edit mode:
   - tone/detail
2. Complete the metadata pass so every content decision surface clearly shows:
   - dimensions
   - file size
   - orientation
   - format
3. Improve ordered set language around triptychs and wall delivery.
4. Build wall-level automation hooks on top of the new set model.
5. Add automated coverage for the content flows before doing another large UX pass.

**Notes Against Similar Apps**

The closest interaction pattern is:
- Google Photos for browse vs albums vs editing separation
- Canva for explicit image preparation and adjustment tooling

This app should follow the same structural split:
- Browse
- Organize
- Edit for display

That is the clearest model for the product now.
