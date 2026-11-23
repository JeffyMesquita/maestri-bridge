# Native Follow verification

**Scope:** the helper-only launch below (`--extensionDevelopmentPath=<native-host>` with an isolated TEMP profile and `--disable-extension=maestri-bridge.maestri-bridge`) is exclusively an isolated automated proof. It is **not** the paired demo and **not** normal product usage. To demonstrate Follow to a user, open the ORIGINAL profile with the product development path and the demo folder/file — no `--user-data-dir`, no `--disable-extension`, no helper, no `--extensionTestsPath`:

```powershell
code --new-window --extensionDevelopmentPath=D:/Projetos-Pessoais/maestri-bridge-pair-study/integrations/vscode --folder-uri=file:///D:/Projetos-Pessoais/maestri-bridge-pair-study/docs/pair-programming/evidence/follow-native-demo --goto D:/Projetos-Pessoais/maestri-bridge-pair-study/docs/pair-programming/evidence/follow-native-demo/invoice.mjs:1
```

This development-only harness imports the product watcher, the real `AgentFollow` controller and `FollowEditor` and uses real VS Code filesystem search, files.exclude and the built-in Git extension API. It creates no activity URI, sends no prompt and opens no wire connection. No helper extension is installed and no trust decision is changed.

Run from the repository root with the existing dependencies:

```powershell
node docs/pair-programming/evidence/follow-native-corrections-20261123/prepare.mjs
$repoRoot = (Get-Location).Path
$proofRoot = Join-Path $repoRoot 'docs/pair-programming/evidence/follow-native-corrections-20261123'
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('follow-native-' + [guid]::NewGuid().ToString('n'))
pnpm --dir integrations/vscode exec esbuild "$proofRoot/harness.ts" --bundle --platform=node --format=cjs --target=node20 --external:vscode --outfile="$proofRoot/native-host/harness.cjs"
code --user-data-dir="$profile" --new-window --extensionDevelopmentPath="$proofRoot/native-host" --disable-extension=maestri-bridge.maestri-bridge --folder-uri ([uri](Join-Path $proofRoot 'workspace')).AbsoluteUri
```

The launch loads only the helper host in an isolated TEMP profile and disables the product extension, so the `maestri-follow` content provider is never registered twice. The real product code (`follow-watch`, `agent-follow`, `follow-editor`) is bundled into `native-host/harness.cjs` at build time; nothing is installed. Do not launch the development host until the orchestration says so. The helper activates only in a trusted workspace. Any required Workspace Trust decision belongs to the human; the commands do not disable or change trust. Keep the synthetic workspace selected. The harness rejects a different root before writing files.

The generated workspace contains a local Git repository, 2,100 ignored text files under generated/, an eligible file and a hidden/ directory excluded by its own files.exclude setting. Preparation resets those synthetic files. The helper writes native-host/result.json and asserts:

- Trust and Git are available, the repository opens, and Git identifies the ignored probe.
- The watcher reaches ready without a partial-snapshot warning for these ignored files.
- Saves in generated/ and hidden/ emit no change.
- The eligible save emits exactly once with its original baseline preserved.
- A temporary junction or symlink root reaches ready; its temporary path is removed after disposal.
- Native burst proof: the real `AgentFollow` targets the fixture root, reaches `following`, and a unique `burst30-<nonce>` directory receives 30 files written 20 ms apart (600 ms). Exactly one modified virtual document stays open, exactly one filename is presented and it is `b29.ts`; the phase stays `following`, the pending queue is empty and remains stable for 350 ms. Both watcher handlers pass the required `activity` callback (a no-op on the exclusion-only probes). The burst directory is removed with a root guard; no other path is deleted.

Keep the generated workspace, local .git directory, compiled helper, result JSON, screenshots and raw captures out of the product commit. Close the helper's Development Host when finished.

The successful Windows run used a normal Extension Development Host. A separate ExtensionTests launch reported an untrusted API context despite the ordinary host's Trust management page showing the folder as trusted. Those failed runner attempts are not a passing result; no trust-disabling flag was used to obtain the successful proof.

## Paired burst verification (2026-11-23T17:39:28Z-17:39:29Z)

On the paired Extension Development Host running bundle `eadf57cb...d37065f` (393,199 bytes), the same 30-file burst (the script sleeps 2 ms between writes; that is the requested value, not a measured cadence) was measured with temporary tracing: one presentation attempt only, `burst/b29.mjs`, result true at perf 204236.1 and completion at 204336.2; 30 changes, no intermediate presentation. The temporary trace was removed afterwards. This is a separate proof from CI run 45177589816 (SHA `1ff2637`). New correction media remains pending and unpublished.

## Clean bundle, second capture and CI

The shipped bundle no longer carries tracing: 391,096 bytes, sha256 `3a7983b3fe93f790607038a18a77ef60e1ef69ada039a0981f55b160dc52b1ab`. The second capture ran a clean 40 s raw (601,211 bytes, 1,123 frames) and the CLI 30-save burst at 2026-11-23T18:11:28Z-18:11:29Z. CI for SHA `754c8aaa` (run 45236149387) passed on Ubuntu, Windows and macOS (macos-26-intel); earlier runs 4116936 and 995871d are historical failures (windows test/infra). The accepted 15 s clip (0-15) is `docs/images/follow-burst-final-20261123.gif` (300 frames, 20 fps, 1,043,773 bytes) and `.mp4` (450 frames, 30 fps, 228,303 bytes); Stop was validated outside it.
