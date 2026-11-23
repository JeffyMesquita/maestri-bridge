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
