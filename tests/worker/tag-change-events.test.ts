import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LibraryService, type AssetsChangedEvent } from '../../src/worker/library-service';
import { importNoConflict } from './import-no-conflict';
import { parseAssetChangeEvent } from '../../src/shared/protocol/responses';

it('preserves the tag-only notification across the IPC schema and omits no-op edits', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-tag-event-'));
  const events: AssetsChangedEvent[] = [];
  const service = new LibraryService({ onAssetsChanged: (event) => events.push(event) });
  try {
    const library = service.createLibrary({ displayName: 'Tags', selectedParentPath: root });
    const source = path.join(root, 'sample.txt');
    writeFileSync(source, 'Tag metadata must not restart thumbnail work.');
    importNoConflict(service, library.libraryId, source);
    const assetId = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!.assetId;
    const tagId = service.createTag({ libraryId: library.libraryId, name: 'test' }).tagId;
    events.length = 0;
    const input = { libraryId: library.libraryId, assetIds: [assetId], tagIds: [tagId] };
    service.assignTags(input);
    service.assignTags(input);
    service.removeTags(input);
    expect(events).toHaveLength(2);
    expect(events.map(parseAssetChangeEvent)).toEqual([
      { type: 'asset.changed', libraryId: library.libraryId, changedCount: 1,
        missingCount: 0, source: 'client', changeKind: 'tags' },
      { type: 'asset.changed', libraryId: library.libraryId, changedCount: 1,
        missingCount: 0, source: 'client', changeKind: 'tags' },
    ]);
  } finally { service.closeAll(); rmSync(root, { recursive: true, force: true }); }
});
