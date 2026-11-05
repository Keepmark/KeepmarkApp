# UI terms (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same words for the same things. Keep this file identical in
`KeepmarkApp/docs/UI-TERMS.md` and `KeepmarkMobile/docs/UI-TERMS.md`.

| Term | Meaning | Do not use |
|---|---|---|
| Service / Service URL | The xBrowserSync-compatible server the sync lives on | Server (as a label) |
| Service URL scheme | The `https://` / `http://` half of a custom service URL, chosen next to the host box | protocol |
| Sync, Sync ID | The encrypted bookmark collection on a service and its ID | sync id (lowercase) |
| Server copy | The encrypted data currently stored on the service | remote, remote side, remote tree |
| Local bookmarks / this device | The bookmarks in this browser or app | native bookmarks, local tree, local side |
| Item(s) | Bookmarks + folders + separators (counts) | nodes |
| Connect | Link this device to a new or existing sync | |
| New sync / Existing sync | The two connect modes | Use existing, … here |
| Syncs | The list of saved syncs on this device (manager Sync section, popup card) | saved syncs, saved list, registry |
| Add a sync (`+ Add a sync`) | Link this device to a new or existing sync without losing the current one (extension: final button `Connect`, result `Sync linked`; Android: direction review with `Continue`, then `Connect and use the server copy` / `Connect and merge` / `Connect and use this device`, restating the outcome); Android offers only an existing sync while linked, the extension also creates a new sync from this browser's bookmarks | Move service, Move to another service, Switch service |
| Activate | Make an inactive saved sync the active one; this device then shows that sync's bookmarks | Open, Load |
| Active | The saved sync this device is using now | in use, current, linked |
| Inactive | A saved sync this device is not using right now | dormant, sleeping, idle, stopped |
| Forget | Remove an inactive sync from the list; the sync and its server copy stay | Remove from the list, Remove |
| Unlink this device | Forget the credentials of the active sync; its bookmarks stay on this device | Unlink this browser, Remove, Delete |
| **Download** | Replace the bookmarks on this device with the server copy | Take remote, Pull |
| **Upload** | Replace the server copy with the bookmarks on this device | Upload local, Upload mine, Overwrite remote, Push |
| **Merge** | Keep everything from both sides; nothing is deleted | union, never deletes |
| Sync conflict | The server copy changed since the last sync; user picks Download / Upload / Merge | |
| Sync lock | Optional short password (a PIN is fine) asked before adding or switching syncs in the **extension**; it is not the sync's own password (Android uses the device unlock instead) | master password, sync password, switch password, sync-change password |
| Backup | Encrypted file export/import (button: Export encrypted backup, Choose backup file…, Check backup, Replace with this backup…) | |
| Safety backups | Snapshots before supported destructive actions or ordinary sync changes affecting more than 10 items (newest 10 kept); no snapshot for ordinary linked-to-linked activation or deliberate browser server deletion | snapshot |
| Copy of the removed sync | The local copy kept when a sync disappeared from the service; Android keeps it encrypted and restorable in Backup → Copies of removed syncs, the extension downloads it as a plain JSON file or dismisses it | orphan copy, orphan backup |
| Duplicates / Duplicate bookmarks | Same URL saved more than once; one copy of each URL always stays | address, link |

`this` follows the platform: both apps say `Unlink this device` (it «Scollega questo
dispositivo»), never `Unlink this browser`. Android uses the same words for the
Syncs page (Syncs, Active, Inactive, Activate, Forget); the extension uses them
in its manager Sync section and popup card.

Android `Move service` is retired: the Syncs list plus `+ Add a sync` in Connect
replace the old nav item and `Move to another service` page, and old
`/connect`, `/switch-service` or `/migrate` links land on Syncs. Its `— Move service`
safety origins are gone too: those backups now read `— Sync switch`. Never copy
that wording into new text.

Confirmation buttons: `Yes, download` · `Yes, upload` · `Yes, merge` · `Yes, unlink` · `Yes, forget` · `Yes, create empty` · `Yes, unlink and keep a copy` · `Yes, change password` · `Yes, restore` · `Yes, delete` · `Yes, clear` (extension server delete: `Yes, delete for good`), always with `Cancel`.
The two connect modes are `New sync` / `Existing sync`, shown as two cards in Android Connect; the extension's Add a sync form uses `A new sync` / `An existing sync`. While a sync is linked, Android `+ Add a sync` offers only `Existing sync`.
Workflow steps, buttons and implication lines: see `WORKFLOWS.md` (identical in both repos).
Busy labels: `Checking…` · `Connecting…` · `Downloading…` · `Uploading…` · `Merging…` · `Changing…` · `Exporting…` · `Importing…`.
Password rule text: "at least 8 characters"; mismatch: "Passwords do not match."
Safety backup origins: `Downloaded server copy — Connect`, `Uploaded local bookmarks — Connect`,
`Merged both sides — Connect`, `Created empty sync — Connect`, `Downloaded server copy — Sync switch`,
`Imported encrypted backup`, `Changed sync password — Sync` (extension) / `Changed sync password — Syncs` (Android), `Deleted duplicates`,
`Before safety-backup restore`, `Conflict resolved: …`, … (see code tables).

Automatic sync is the only mobile setting; `Sync now` means an explicit attempt,
not a separate Manual mode. Browser sync includes Menu, Other and Toolbar without
an exclusion switch. Activating another sync preserves the outgoing server copy;
Download / Upload / Merge remain choices only where a reconciliation is needed.

## Translations (it / fr / es / de / ja / pt-BR / ro / ru / zh)

UI languages: English (source), Italiano, Français, Español, Deutsch, 日本語,
Português (Brasil), Română, Русский, 简体中文 (internal codes `ja`, `pt`, `ro`, `ru`,
`zh`; browser manifest locales `ja`, `pt_BR`, `ro`, `ru`, `zh_CN`). Always use these
terms, also inside longer sentences. Register: it "tu", fr "vous", es "tú", de "du",
ja です/ます, pt-BR "você", ro "tu", ru "вы", zh "您".
Never translate: Keepmark, xBrowserSync, API, URL, PIN, file names.

| English | Italiano | Français | Español | Deutsch |
|---|---|---|---|---|
| bookmarks | segnalibri | favoris | marcadores | Lesezeichen |
| item(s) | elementi | éléments | elementos | Elemente |
| sync (noun) | sincronizzazione | synchronisation | sincronización | Synchronisierung |
| Sync ID | ID di sincronizzazione | ID de synchronisation | ID de sincronización | Sync-ID |
| Sync now | Sincronizza ora | Synchroniser maintenant | Sincronizar ahora | Jetzt synchronisieren |
| Service / Service URL | Servizio / URL del servizio | Service / URL du service | Servicio / URL del servicio | Dienst / Dienst-URL |
| Server copy | Copia sul server | Copie du serveur | Copia del servidor | Serverkopie |
| this device / this browser | questo dispositivo / questo browser | cet appareil / ce navigateur | este dispositivo / este navegador | dieses Gerät / dieser Browser |
| Connect | Collega | Connecter | Conectar | Verbinden |
| Link / Unlink | Collega / Scollega | Associer / Dissocier | Vincular / Desvincular | Verknüpfen / Trennen |
| linked | collegato | associé | vinculado | verknüpft |
| Unlink this device | Scollega questo dispositivo | Dissocier cet appareil | Desvincular este dispositivo | Dieses Gerät trennen |
| Download | Scarica | Télécharger | Descargar | Herunterladen |
| Upload | Carica | Envoyer | Subir | Hochladen |
| Merge | Unisci | Fusionner | Combinar | Zusammenführen |
| Sync conflict | Conflitto di sincronizzazione | Conflit de synchronisation | Conflicto de sincronización | Synchronisierungskonflikt |
| Syncs | Sincronizzazioni | Synchronisations | Sincronizaciones | Synchronisierungen |
| Add a sync | Aggiungi un sync | Ajouter un sync | Añadir un sync | Sync hinzufügen |
| Activate | Attiva | Activer | Activar | Aktivieren |
| Active | Attivo | Actif | Activo | Aktiv |
| Inactive | Inattivo | Inactif | Inactivo | Inaktiv |
| Forget | Dimentica | Oublier | Olvidar | Vergessen |
| Sync lock | blocco sync | verrou des syncs | bloqueo de sync | Sync-Sperre |
| Backup | Backup | Sauvegarde | Copia de seguridad | Sicherung |
| Safety backups | Backup di sicurezza | Sauvegardes de sécurité | Copias de seguridad preventivas | Sicherheitskopien |
| Copy of the removed sync | Copia del sync rimosso | Copie du sync supprimé | Copia del sync eliminado | Kopie des entfernten Syncs |
| Export / Restore | Esporta / Ripristina | Exporter / Restaurer | Exportar / Restaurar | Exportieren / Wiederherstellen |
| Undo | Annulla modifica | Annuler la modification | Deshacer | Rückgängig |
| Duplicates | Duplicati | Doublons | Duplicados | Duplikate |
| Yes, download | Sì, scarica | Oui, télécharger | Sí, descargar | Ja, herunterladen |
| Yes, upload | Sì, carica | Oui, envoyer | Sí, subir | Ja, hochladen |
| Yes, merge | Sì, unisci | Oui, fusionner | Sí, combinar | Ja, zusammenführen |
| Yes, unlink | Sì, scollega | Oui, dissocier | Sí, desvincular | Ja, trennen |
| Yes, delete | Sì, elimina | Oui, supprimer | Sí, eliminar | Ja, löschen |
| Cancel | Annulla | Annuler | Cancelar | Abbrechen |
| Settings | Impostazioni | Paramètres | Ajustes | Einstellungen |
| Status | Stato | État | Estado | Status |
| Logs | Log | Journaux | Registros | Protokolle |
| Show logs | Mostra i log | Afficher les journaux | Mostrar registros | Protokolle anzeigen |
| About | Informazioni | À propos | Acerca de | Info |
| Language | Lingua | Langue | Idioma | Sprache |
| System default | Lingua di sistema | Langue du système | Idioma del sistema | Systemsprache |
| password | password | mot de passe | contraseña | Passwort |
| Online / Offline | Online / Offline | En ligne / Hors ligne | En línea / Sin conexión | Online / Offline |

| English | Română |
|---|---|
| bookmarks | marcaje |
| item(s) | element / elemente |
| sync (noun) | sincronizare |
| Sync ID | ID sincronizare |
| Sync now | Sincronizează acum |
| Service / Service URL | Serviciu / URL-ul serviciului |
| Server copy | Copia de pe server |
| this device / this browser | acest dispozitiv / acest browser |
| Connect | Conectează |
| Link / Unlink | Conectează / Deconectează |
| linked | conectat |
| Unlink this device | Deconectează acest dispozitiv |
| Download | Descarcă |
| Upload | Încarcă |
| Merge | Îmbină |
| Sync conflict | Conflict de sincronizare |
| Syncs | Sincronizări |
| Add a sync | Adaugă o sincronizare |
| Activate | Activează |
| Active | Activă |
| Inactive | Inactivă |
| Forget | Uită |
| Sync lock | blocarea sincronizării |
| Backup | Copie de rezervă |
| Safety backups | Copii de siguranță |
| Copy of the removed sync | Copia sincronizării eliminate |
| Export / Restore | Exportă / Restaurează |
| Undo | Anulează |
| Duplicates | Duplicate |
| Yes, download | Da, descarcă |
| Yes, upload | Da, încarcă |
| Yes, merge | Da, îmbină |
| Yes, unlink | Da, deconectează |
| Yes, delete | Da, șterge |
| Cancel | Anulează |
| Settings | Setări |
| Status | Stare |
| Logs | Jurnale |
| Show logs | Arată jurnalele |
| About | Despre |
| Language | Limbă |
| System default | Limba sistemului |
| password | parolă |
| Online / Offline | Online / Offline |

| English | 日本語 | Português (Brasil) | Русский | 简体中文 |
|---|---|---|---|---|
| bookmarks | ブックマーク | favoritos | закладки | 书签 |
| item(s) | 項目 | itens | элементы | 项目 |
| sync (noun) | 同期 | sincronização | синхронизация | 同步 |
| Sync ID | 同期 ID | ID de sincronização | ID синхронизации | 同步 ID |
| Sync now | 今すぐ同期 | Sincronizar agora | Синхронизировать | 立即同步 |
| Service / Service URL | サービス / サービス URL | Serviço / URL do serviço | Сервис / URL сервиса | 服务 / 服务 URL |
| Server copy | サーバーのコピー | Cópia do servidor | Копия на сервере | 服务器副本 |
| this device / this browser | このデバイス / このブラウザ | este dispositivo / este navegador | это устройство / этот браузер | 此设备 / 此浏览器 |
| Connect | 接続 | Conectar | Подключение | 连接 |
| Link / Unlink | リンク / リンクを解除 | Vincular / Desvincular | Привязать / Отвязать | 关联 / 取消关联 |
| Unlink this device | このデバイスのリンクを解除 | Desvincular este dispositivo | Отвязать это устройство | 取消关联此设备 |
| Download | ダウンロード | Baixar | Скачать | 下载 |
| Upload | アップロード | Enviar | Отправить | 上传 |
| Merge | 統合 | Mesclar | Объединить | 合并 |
| Sync conflict | 同期の競合 | Conflito de sincronização | Конфликт синхронизации | 同步冲突 |
| Syncs | 同期 | Sincronizações | Синхронизации | 同步 |
| Add a sync | 同期を追加 | Adicionar sync | Добавить синхронизацию | 添加同步 |
| Activate | 有効化 | Ativar | Активировать | 启用 |
| Active | 使用中 | Ativo | Активна | 使用中 |
| Inactive | 未使用 | Inativo | Неактивна | 未启用 |
| Forget | 忘れる | Esquecer | Забыть | 忘记 |
| Sync lock | 同期ロック | bloqueio de sync | блокировка синхронизации | 同步锁 |
| Backup | バックアップ | Backup | Резервная копия | 备份 |
| Safety backups | 安全バックアップ | Backups de segurança | Страховочные копии | 安全备份 |
| Copy of the removed sync | 削除された同期のコピー | Cópia do sync removido | Копия удалённого sync | 已删除同步的副本 |
| Undo | 元に戻す | Desfazer | Отменить | 撤销 |
| Duplicates | 重複 | Duplicados | Дубликаты | 重复项 |
| Yes, download | はい、ダウンロード | Sim, baixar | Да, скачать | 是，下载 |
| Yes, merge | はい、統合 | Sim, mesclar | Да, объединить | 是，合并 |
| Yes, delete | はい、削除 | Sim, excluir | Да, удалить | 是，删除 |
| Cancel | キャンセル | Cancelar | Отмена | 取消 |
| Settings | 設定 | Configurações | Настройки | 设置 |
| Language | 言語 | Idioma | Язык | 语言 |
| password | パスワード | senha | пароль | 密码 |
| Online / Offline | オンライン / オフライン | Online / Offline | В сети / Нет сети | 在线 / 离线 |

Plural forms: the code distinguishes only `_one` / `_other`. ja and zh use the same
text for both; ro and ru `_other` carry the plain plural (`Intl.PluralRules` maps
Romanian `few` and `other` there) so it reads right for 2+; pt-BR, like fr, treats 0
as `_one`.
