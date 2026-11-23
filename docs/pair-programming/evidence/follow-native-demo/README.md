# Follow demo

- Start Follow in the Development Host before changing the files.
- Save a change to invoice.mjs from the terminal and inspect the native diff.
- Change the editor selection and save changes to both files. The pending count should reach two without opening another tab.
- Use View to open the latest changed file directly, without a picker. Make one more save to confirm automatic following resumed.
- Keep the whole editor window visible during capture. Keep connection settings and prompts outside the recording.

## Reproduce on Windows

Use a fresh copy of this fixture. In the Development Host, select this folder as the local Follow root, select the Chat target without sending a message, and enable the **Follow** header toggle. The fixture uses filesystem saves only; it does not emit activity URIs or prompt an agent.

Run the following from the repository root, performing the editor interaction between steps:

```powershell
powershell -NoProfile -File docs/pair-programming/evidence/follow-native-demo-saves.ps1 -Step First
node --test --test-concurrency=1 docs/pair-programming/evidence/follow-native-demo/invoice.test.mjs
```

Confirm the source diff against the initial `return subtotal;` baseline. Select code in the read-only diff to pause navigation, then run:

```powershell
powershell -NoProfile -File docs/pair-programming/evidence/follow-native-demo-saves.ps1 -Step Paused
node --test --test-concurrency=1 docs/pair-programming/evidence/follow-native-demo/invoice.test.mjs
```

Confirm **2 files changed · View** on its own line while the previous diff remains in place. Click **View** and confirm that the latest changed file opens directly, still compares with the original baseline, and resumes following. Then run:

```powershell
powershell -NoProfile -File docs/pair-programming/evidence/follow-native-demo-saves.ps1 -Step Resume
node --test --test-concurrency=1 docs/pair-programming/evidence/follow-native-demo/invoice.test.mjs
```

Confirm automatic navigation to the test-file diff. The three stages produced 1, 2 and 3 passing fixture tests. Turn Follow off in its header before restoring the fixture from a fresh copy. The recorded run's baseline was restored byte-for-byte.

## Burst and current recording

After resumption, run the following while Follow is active:

```powershell
powershell -NoProfile -File docs/pair-programming/evidence/follow-native-demo-saves.ps1 -Step Burst
node --check docs/pair-programming/evidence/follow-native-demo/burst/b29.mjs
```

This creates 30 synthetic files, b0.mjs through b29.mjs, with real filesystem saves. The script refuses to overwrite an existing burst directory. Confirm that Follow ends at b29 with sequence 29, then turn it off before restoring the invoice files and removing only the generated burst directory. Native delivery may expose intermediate previews; the current recording shows b0, b24 and b29.

The current [GIF](../../../images/follow-corrections-20261123.gif) and [MP4](../../../images/follow-corrections-20261123.mp4) preserve the full 1920 × 1032 window. Seven normal-speed excerpts remove only waits from the 265.767-second raw capture: 25–31, 54–60, 92–101, 134–143, 167–175, 206–222 and 258–264 seconds. The GIF is 60 seconds; the MP4 is 59.967 seconds due to frame-grid rounding. Stop is visible in this recording. Review is sampled, without a latency benchmark or continuous-playback claim.

## Historical recording before the direct-View correction

The MP4/GIF show the full 1920 × 1032 editor window. Five normal-speed excerpts of the 240-second capture remove only waiting intervals: 10–17, 80–88, 123–131, 160–181 and 203–213 seconds. The encoded clip is approximately 54 seconds; frame boundaries produce a small rounding difference. No spatial crop, scaling, masks, simulated typing or sped-up playback are used.

The final pending-files state was checked in the encoded clip. Stop was verified separately in the GUI, after the recording ended, and is not claimed as part of the video. The selected target's Chat-disabled banner and ordinary editor notices are authentic UI. No message was sent to the target.
