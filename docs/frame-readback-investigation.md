**Current Findings**

- The current `@weejewel/samsung-emdx` flow can verify:
  - MDC connection succeeded
  - `setContentDownload()` succeeded
  - the frame fetched `/content.json`
  - the frame fetched `/image`

- It cannot verify, with the current library alone, that the panel visibly applied the image after fetching it.

- It also cannot read back the current content from the frame. The available MDC wrapper exposes `setContentDownload()` but not a matching `get current content` call.

- During local inspection on this machine, there was no obvious installed Samsung EMDX desktop app process or Store package to inspect directly. That means the app you are using may be:
  - a mobile app
  - a different desktop binary not currently running
  - or a Samsung package installed outside the usual Windows app locations

**What The New Send Job Can Tell Us**

The app now tracks live delivery milestones:

- wake sent
- connected
- command set
- `content.json` fetched
- image fetched

If a send completes and the modal shows `image fetched`, that means the frame really did request the image from this app. If the panel still does not change, the failure is likely after fetch:

- panel-side apply/refresh behavior
- content acceptance rules not modeled by the current CLI
- firmware-specific timing
- display-side caching or stale-program behavior

**Readback Feasibility**

Reading “what is currently on screen” still looks possible in principle, but not from the current wrapper. The fact that the Samsung app shows current content implies some other API or undocumented endpoint exists.

Most likely paths:

1. Another MDC command not implemented in `@weejewel/samsung-mdc`
2. A local device HTTP/API surface separate from MDC
3. A Samsung cloud/app service that tracks deployed content
4. A proprietary mobile-app protocol

**Best Next Investigation**

1. Launch the Samsung app while a frame is online.
2. Run the connection watcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\watch-frame-connections.ps1 -FrameIps 192.168.4.244,192.168.4.255
```

3. While watching, open the device in the Samsung app and refresh its status/content view.
4. Note:
   - process name
   - remote port
   - whether it talks directly to the frame IP or to cloud endpoints

If it talks directly to the frame, the next step is a packet capture while reproducing the “show current content” action.

**Packet Capture Note**

A real packet capture is the right tool for discovering content readback, but it should be started only while the Samsung app is active and reproducing the exact action. On Windows, that likely means `pktmon`, `netsh trace`, or Wireshark.

I have not started a packet capture automatically here because:

- it is noisy without the app actively reproducing the behavior
- the current machine inspection did not reveal a live Samsung app process to follow
- a blind long-running capture is low-signal compared to a targeted one
