import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, 'workspace');

await mkdir(join(root, '.vscode'), { recursive: true });
await mkdir(join(root, 'generated'), { recursive: true });
await mkdir(join(root, 'hidden'), { recursive: true });

await writeFile(join(root, '.gitignore'), 'generated/\n');
await writeFile(join(root, '.vscode', 'settings.json'), '{ "files.exclude": { "**/hidden": true } }\n');
await writeFile(join(root, 'legit.ts'), 'legit one\n');
await writeFile(join(root, 'hidden', 'h.ts'), 'hidden one\n');

const jobs = [];
for (let index = 0; index < 2100; index += 1) {
  jobs.push(writeFile(join(root, 'generated', `g${index}.ts`), 'x\n'));
}
await Promise.all(jobs);

try {
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'local@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'local'], { stdio: 'ignore' });
  console.log('workspace ready with git repo');
} catch (error) {
  console.log('workspace ready WITHOUT git:', String(error));
}
