import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * README.md's `## Settings` table is hand-written prose, not generated - so
 * nothing stops it drifting from `package.json` the moment a setting's
 * default changes or a new one is added. This test parses the table exactly
 * as a reader would - short of reading `package.json` itself - and checks it
 * against the manifest: every `claudeLimitBreak.*` property is listed with
 * its declared default, and nothing listed is not in the manifest.
 *
 * A row's Setting/Default cell can name more than one setting at once (the
 * `alertSound` / `alertSoundFile` and `randomDelayMinMinutes` /
 * `randomDelayMaxMinutes` rows), each backtick-quoted name paired
 * positionally with the backtick-quoted default in the same slash-joined
 * position - so parsing splits on ` / ` before stripping backticks, rather
 * than just collecting every backtick span in the row.
 */

function readManifestProperties(): Record<string, { default: unknown }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  return manifest.contributes.configuration.properties;
}

/** The manifest's JSON default, rendered the way the README table renders it:
 * an empty string as `""`, everything else via String(). */
function expectedDefaultText(value: unknown): string {
  if (value === '') {
    return '""';
  }
  return String(value);
}

/** One name/default pair per setting named in a table row, in column order. */
interface ParsedRow {
  name: string;
  defaultText: string;
}

function splitCell(cell: string): string[] {
  return cell.split(' / ').map((part) => {
    const m = part.trim().match(/^`(.*)`$/s);
    assert.ok(m, `README settings cell is not backtick-quoted: ${JSON.stringify(part)}`);
    return m![1]!;
  });
}

function parseReadmeSettingsTable(readme: string): ParsedRow[] {
  const section = readme.split(/^## Settings$/m)[1];
  assert.ok(section, 'README.md has no "## Settings" section');
  const nextHeading = section!.search(/^## /m);
  const body = nextHeading === -1 ? section! : section!.slice(0, nextHeading);

  const rows: ParsedRow[] = [];
  for (const line of body.split('\n')) {
    // Data rows only: start with "| `" (the Setting column is always
    // backtick-quoted names). Skips the header row ("| Setting | ...") and
    // the separator row ("|---|---|---|").
    if (!line.startsWith('| `')) {
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is '' (text before the leading "|"); Setting is cells[1], Default is cells[2].
    const names = splitCell(cells[1]!);
    const defaults = splitCell(cells[2]!);
    assert.equal(
      names.length,
      defaults.length,
      `README settings row has ${names.length} name(s) but ${defaults.length} default(s): ${line}`,
    );
    for (let i = 0; i < names.length; i++) {
      rows.push({ name: names[i]!, defaultText: defaults[i]! });
    }
  }
  assert.ok(rows.length > 0, 'parsed zero rows out of the README settings table');
  return rows;
}

test('the README settings table matches package.json exactly: every setting, correct default, no extras', () => {
  const properties = readManifestProperties();
  const declared = new Map(
    Object.entries(properties).map(([key, prop]) => [key.replace('claudeLimitBreak.', ''), prop]),
  );
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const rows = parseReadmeSettingsTable(readme);

  const listed = new Set<string>();
  for (const row of rows) {
    assert.ok(!listed.has(row.name), `README lists '${row.name}' more than once in the settings table`);
    listed.add(row.name);
    const prop = declared.get(row.name);
    assert.ok(prop, `README lists '${row.name}', which package.json does not declare`);
    assert.equal(
      row.defaultText,
      expectedDefaultText(prop!.default),
      `README's default for '${row.name}' is ${JSON.stringify(row.defaultText)}, package.json says ${JSON.stringify(expectedDefaultText(prop!.default))}`,
    );
  }
  for (const key of declared.keys()) {
    assert.ok(listed.has(key), `package.json declares 'claudeLimitBreak.${key}', which the README settings table is missing`);
  }
});
