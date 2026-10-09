// User-facing workflow texts: confirmations, implication lines and results.
// One place to read and change them; wording follows docs/UI-TERMS.md and
// docs/WORKFLOWS.md (kept identical to the Android app). Every text is a
// function (or reads the active language at call time): never a module-level
// constant, which would be frozen before the language is loaded.

import { formatDateTime, t, tn } from '../shared/i18n.js';

export const ChangePasswordImplication = (): string => t('texts.changePwImplication');
export const ChangePasswordDone = (): string => t('texts.changePwDone');

// Backup → Export.
export const BackupPasswordHint = (): string => t('texts.backupPwHint');
export const exportDone = (fileName: string): string => t('texts.exportDone', { fileName });

// Backup → Restore from a backup file.
export const importChecked = (fileName: string, count: number): string =>
  tn('texts.importChecked', count, { fileName });
export const ImportImplication = (): string => t('texts.importImplication');
export const importDone = (count: number): string => tn('texts.importDone', count);

// Backup → Safety backups.
export const safetyRestoreImplication = (side: 'local' | 'remote', items: number): string =>
  tn(side === 'local' ? 'texts.safetyRestoreLocal' : 'texts.safetyRestoreRemote', items);
export const safetyRestoreDone = (count: number, preFile: string): string =>
  tn('texts.safetyRestoreDone', count, { preFile });
export const SafetyDeleteImplication = (): string => t('texts.safetyDeleteImplication');

// Duplicates.
export const dupDeleteConfirm = (count: number): { message: string; implication: string; confirmLabel: string } => ({
  message: tn('texts.dupDeleteMessage', count),
  implication: t('texts.dupDeleteImplication'),
  confirmLabel: t('common.yesDelete'),
});
export const dupDeleteDone = (count: number): string => tn('texts.dupDeleteDone', count);

// Status → Danger zone.
export const UnlinkImplication = (): string => t('texts.unlinkImplication');
export const UnlinkDone = (): string => t('texts.unlinkDone');
export const DeleteRemoteImplication = (): string => t('texts.deleteRemoteImplication');
export const DeleteRemoteDone = (): string => t('texts.deleteRemoteDone');

// Popup → server-removed sync card.
export function removedSyncText(count: number, lastUpdated?: string): string {
  const when = lastUpdated ? ` ${t('texts.removedSyncWhen', { date: formatDateTime(lastUpdated) })}` : '';
  return tn('texts.removedSync', count, { when });
}
export const RemovedSyncDismissImplication = (): string => t('texts.removedDismissImplication');

// Direction choice (Connect existing sync, Move into an existing sync,
// Conflict). One order everywhere: server copy, merge, this browser's copy.
export type Direction = 'pull' | 'merge' | 'push';
export const DirectionOrder: readonly Direction[] = ['pull', 'merge', 'push'];

const directionConfirmLabel: Record<Direction, 'common.yesDownload' | 'common.yesMerge' | 'common.yesUpload'> = {
  pull: 'common.yesDownload',
  merge: 'common.yesMerge',
  push: 'common.yesUpload',
};
export const directionConfirm = (d: Direction): { message: string; implication: string; confirmLabel: string } => ({
  message: t(`texts.dir.${d}.message` as const),
  implication: t(`texts.dir.${d}.implication` as const),
  confirmLabel: t(directionConfirmLabel[d]),
});

// Move service.
export const MoveImplication = (): string => t('texts.moveImplication');
export const moveNewConfirm = (url: string, count?: number): string =>
  count === undefined ? t('texts.moveNewConfirmNoCount', { url }) : tn('texts.moveNewConfirm', count, { url });
export const MoveDoneNext = (): string => t('texts.moveDoneNext');

// Undo (Status banner in the manager, popup banner).
const undoKeys = {
  'connect-new': 'texts.undo.connectNew',
  'connect-pull': 'texts.undo.connectPull',
  'connect-push': 'texts.undo.connectPush',
  'connect-merge': 'texts.undo.connectMerge',
  'switch-new': 'texts.undo.switchNew',
  'switch-pull': 'texts.undo.switchPull',
  'switch-push': 'texts.undo.switchPush',
  'switch-merge': 'texts.undo.switchMerge',
  'change-password': 'texts.undo.changePassword',
  restore: 'texts.undo.restore',
  duplicates: 'texts.undo.duplicates',
} as const;
/** What the undo slot `kind` did, in words (never the raw key). */
export function undoWhat(kind: string): string {
  return t(kind in undoKeys ? undoKeys[kind as keyof typeof undoKeys] : 'texts.undo.import');
}
export const undoConfirm = (kind: string): { message: string; implication: string; confirmLabel: string } => ({
  message: t('texts.undoMessage'),
  implication: t('texts.undoImplication', { what: undoWhat(kind) }),
  confirmLabel: t('common.yesUndo'),
});
export const undoneText = (kind: string): string => t('texts.undone', { what: undoWhat(kind) });
