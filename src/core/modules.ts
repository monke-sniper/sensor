// Electron-independent service modules, registered in order.
import type { CoreModule } from './core';
import { notesModule } from './services/notes';
import { filesModule } from './services/files';
import { annotationsModule, clipboardModule, recognizerModule } from './services/knowledge-extras';
import { rssModule } from './services/rss';
import { documentsModule } from './services/documents';
import { macrosModule } from './services/macros';
import { devModule } from './services/dev';
import { aiModule } from './services/ai';
import { backupModule } from './services/backup';
import { scriptsModule } from './services/scripts';

export function allModules(opts: { indexerWorker?: string | null } = {}): CoreModule[] {
  return [notesModule, filesModule(opts.indexerWorker ?? null), annotationsModule, clipboardModule, recognizerModule, rssModule, documentsModule, macrosModule(), devModule, aiModule, backupModule(), scriptsModule()];
}
