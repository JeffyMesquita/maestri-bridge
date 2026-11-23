param(
  [Parameter(Mandatory)]
  [ValidateSet('First','Paused','Resume','Burst')]
  [string]$Step
)

$fixture = Join-Path $PSScriptRoot 'follow-native-demo'
$sourcePath = Join-Path $fixture 'invoice.mjs'
$testPath = Join-Path $fixture 'invoice.test.mjs'
$utf8 = [Text.UTF8Encoding]::new($false)

switch ($Step) {
  'Burst' {
    $burstPath = Join-Path $fixture 'burst'
    if (Test-Path -LiteralPath $burstPath) { throw 'Burst fixture already exists; preserve it before another run.' }
    New-Item -ItemType Directory -Path $burstPath | Out-Null
    for ($index = 0; $index -lt 30; $index++) {
      [IO.File]::WriteAllText((Join-Path $burstPath "b$index.mjs"), "export const sequence = $index;`n", $utf8)
      Start-Sleep -Milliseconds 2
    }
  }
  'First' {
    $source = [IO.File]::ReadAllText($sourcePath)
    if (!$source.Contains('return subtotal;')) { throw 'Start with the original invoice fixture.' }
    $updated = $source.Replace('return subtotal;', 'return Math.round(subtotal * 100) / 100;')
    [IO.File]::WriteAllText($sourcePath, $updated, $utf8)
  }
  'Paused' {
    $source = [IO.File]::ReadAllText($sourcePath)
    $test = [IO.File]::ReadAllText($testPath)
    if (!$source.Contains('Math.round(subtotal * 100)') -or $test.Contains('applies an invoice discount')) {
      throw 'Run the First step once before Paused.'
    }
    $updated = $source.Replace('invoiceTotal(items)', 'invoiceTotal(items, discount = 0)')
    $updated = $updated.Replace('Math.round(subtotal * 100)', 'Math.round(Math.max(0, subtotal - discount) * 100)')
    [IO.File]::WriteAllText($sourcePath, $updated, $utf8)
    Start-Sleep -Milliseconds 700
    $newTest = @'
test('applies an invoice discount', () => {
  assert.equal(invoiceTotal([{ price: 30, quantity: 1 }], 5), 25);
});
'@
    [IO.File]::WriteAllText($testPath, ($test.TrimEnd() + "`n`n" + $newTest + "`n"), $utf8)
  }
  'Resume' {
    $test = [IO.File]::ReadAllText($testPath)
    if (!$test.Contains('applies an invoice discount') -or $test.Contains('never returns a negative invoice')) {
      throw 'Run the Paused step once before Resume.'
    }
    $newTest = @'
test('never returns a negative invoice', () => {
  assert.equal(invoiceTotal([{ price: 8, quantity: 1 }], 12), 0);
});
'@
    [IO.File]::WriteAllText($testPath, ($test.TrimEnd() + "`n`n" + $newTest + "`n"), $utf8)
  }
}
