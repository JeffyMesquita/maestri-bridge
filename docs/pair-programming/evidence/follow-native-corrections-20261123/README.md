# Native Follow verification

This development-only harness imports the product watcher and uses real VS Code filesystem search, files.exclude and the built-in Git extension API. It creates no activity URI and sends no message to an agent. No helper extension is installed.

Run from the repository root with the existing dependencies:

```powershell
node docs/pair-programming/evidence/follow-native-corrections-20261123/prepare.mjs
$repoRoot = (Get-Location).Path
$proofRoot = Join-Path $repoRoot 'docs/pair-programming/evidence/follow-native-corrections-20261123'
pnpm --dir integrations/vscode exec esbuild "$proofRoot/harness.ts" --bundle --platform=node --format=cjs --target=node20 --external:vscode --outfile="$proofRoot/native-host/harness.cjs"
code --new-window --extensionDevelopmentPath="$repoRoot/integrations/vscode" --extensionDevelopmentPath="$proofRoot/native-host" --folder-uri ([uri](Join-Path $proofRoot 'workspace')).AbsoluteUri
```

The helper activates only in a trusted workspace. Any required Workspace Trust decision belongs to the human; the commands do not disable or change trust. Keep the synthetic workspace selected. The harness rejects a different root before writing files.

The generated workspace contains a local Git repository, 2,100 ignored text files under generated/, an eligible file and a hidden/ directory excluded by its own files.exclude setting. Preparation resets those synthetic files. The helper writes native-host/result.json and asserts:

- Trust and Git are available, the repository opens, and Git identifies the ignored probe.
- The watcher reaches ready without a partial-snapshot warning for these ignored files.
- Saves in generated/ and hidden/ emit no change.
- The eligible save emits exactly once with its original baseline preserved.
- A temporary junction or symlink root reaches ready; its temporary path is removed after disposal.

Keep the generated workspace, local .git directory, compiled helper, result JSON, screenshots and raw captures out of the product commit. Close the helper's Development Host when finished.

The successful Windows run used a normal Extension Development Host. A separate ExtensionTests launch reported an untrusted API context despite the ordinary host's Trust management page showing the folder as trusted. Those failed runner attempts are not a passing result; no trust-disabling flag was used to obtain the successful proof.
