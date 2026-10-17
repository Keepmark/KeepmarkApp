# UI terms (shared by Keepmark browser extension and Keepmark Android)

Both apps use the same words for the same things. Keep this file identical in
`KeepmarkApp/docs/UI-TERMS.md` and `KeepmarkMobile/docs/UI-TERMS.md`.

| Term | Meaning | Do not use |
|---|---|---|
| Service / Service URL | The xBrowserSync-compatible server the sync lives on | Server (as a label) |
| Sync, Sync ID | The encrypted bookmark collection on a service and its ID | sync id (lowercase) |
| Server copy | The encrypted data currently stored on the service | remote, remote side, remote tree |
| Local bookmarks / this device | The bookmarks in this browser or app | native bookmarks, local tree, local side |
| Item(s) | Bookmarks + folders + separators (counts) | nodes |
| Connect | Link this device to a new or existing sync | |
| New sync / Existing sync | The two connect modes | Use existing, … here |
| Unlink this device | Forget the credentials; local bookmarks stay | extension: "Unlink this browser" |
| **Download** | Replace the bookmarks on this device with the server copy | Take remote, Pull |
| **Upload** | Replace the server copy with the bookmarks on this device | Upload local, Upload mine, Overwrite remote, Push |
| **Merge** | Keep everything from both sides; nothing is deleted | union, never deletes |
| Sync conflict | The server copy changed since the last sync; user picks Download / Upload / Merge | |
| Move service / Move to another service | Wizard that moves the sync to another service (button: Move and connect, result: Move complete) | Switch service |
| Backup | Encrypted file export/import (button: Export encrypted backup, Choose backup file…, Check backup, Replace with this backup…) | |
| Safety backups | Automatic snapshots taken before every overwrite or deletion (newest 5 kept) | snapshot |
| Duplicates / Duplicate bookmarks | Same URL saved more than once; one copy of each URL always stays | address, link |

Confirmation buttons: `Yes, download` · `Yes, upload` · `Yes, merge` · `Yes, unlink` · `Yes, change password` · `Yes, restore` · `Yes, delete` (second step of a server delete: `Yes, delete for good`), always with `Cancel`.
Workflow steps, buttons and implication lines: see `WORKFLOWS.md` (identical in both repos).
Busy labels: `Downloading…` · `Uploading…` · `Merging…`.
Password rule text: "at least 8 characters"; mismatch: "Passwords do not match."
Safety backup origins: `Downloaded server copy — Connect`, `Uploaded local bookmarks — Connect`,
`Downloaded server copy — Move service`, `Merged both sides — Move service`, … (see code tables).

## Translations (it / fr / es / de / ja / pt-BR / ru / zh)

UI languages: English (source), Italiano, Français, Español, Deutsch, 日本語,
Português (Brasil), Русский, 简体中文 (internal codes `ja`, `pt`, `ru`, `zh`; browser
manifest locales `ja`, `pt_BR`, `ru`, `zh_CN`). Always use these terms, also inside
longer sentences. Register: it "tu", fr "vous", es "tú", de "du", ja です/ます,
pt-BR "você", ru "вы", zh "您".
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
| Download | Scarica | Télécharger | Descargar | Herunterladen |
| Upload | Carica | Envoyer | Subir | Hochladen |
| Merge | Unisci | Fusionner | Combinar | Zusammenführen |
| Sync conflict | Conflitto di sincronizzazione | Conflit de synchronisation | Conflicto de sincronización | Synchronisierungskonflikt |
| Move service | Cambia servizio | Changer de service | Cambiar de servicio | Dienst wechseln |
| Backup | Backup | Sauvegarde | Copia de seguridad | Sicherung |
| Safety backups | Backup di sicurezza | Sauvegardes de sécurité | Copias de seguridad preventivas | Sicherheitskopien |
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
| About | Informazioni | À propos | Acerca de | Info |
| Language | Lingua | Langue | Idioma | Sprache |
| System default | Lingua di sistema | Langue du système | Idioma del sistema | Systemsprache |
| password | password | mot de passe | contraseña | Passwort |
| Online / Offline | Online / Offline | En ligne / Hors ligne | En línea / Sin conexión | Online / Offline |

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
| Download | ダウンロード | Baixar | Скачать | 下载 |
| Upload | アップロード | Enviar | Отправить | 上传 |
| Merge | 統合 | Mesclar | Объединить | 合并 |
| Sync conflict | 同期の競合 | Conflito de sincronização | Конфликт синхронизации | 同步冲突 |
| Move service | サービスの移行 | Mudar de serviço | Сменить сервис | 迁移服务 |
| Backup | バックアップ | Backup | Резервная копия | 备份 |
| Safety backups | 安全バックアップ | Backups de segurança | Страховочные копии | 安全备份 |
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
text for both; ru `_other` uses a count-neutral form ("Закладок: {count}") so it reads
right for 2–4 and 5+; pt-BR, like fr, treats 0 as `_one`.
