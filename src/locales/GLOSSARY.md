# Translation glossary

Each `<tag>.json` here holds one language's text, keyed by the English message id (its English, plus `#description`
when two messages read alike). Whoever adds or changes an English string translates it into every catalogue in the
same change, using the terms below, and runs `npm run i18n:check`. The rules for every language are stub's
(`src/locales/GLOSSARY.md` there), so the two apps read alike.

## Every language

- **Never translated:** Ripple, FKN, Sintel, BitTorrent, qBittorrent, VPN, and the protocol names DHT, PeX, LSD, uTP and
  WebRTC.
- **A label stub already shows** takes stub's text as it stands, so the two apps read alike. The exceptions are `ko`
  Remove, `제거` where stub writes `삭제`: ripple's `Remove and delete` needs both words; and two words stub means of a
  watch list. Paused takes qBittorrent's word where stub's reads as on hold (`ru` `На паузе`, `tr` `Duraklatıldı`,
  `zh-Hans` `已暂停`, `zh-Hant` `已暫停`, `pl` `Wstrzymano`, `ko` `일시 중지됨`), and Progress where stub's reads as how
  much was watched (`it` `Avanzamento`, `ja` `進捗`, `ko` `진행률`, `zh-Hans` `进度`, `zh-Hant` `進度`). A torrent's Format
  is `格式` in Chinese, where stub's `形式` is a show's.
- **No em or en dash** (U+2014, U+2013), even where the language's typography uses one: restructure, or use a comma,
  a colon, a plain hyphen or the language's own range mark (`～` in Japanese, `~` in Korean, `至` in Chinese).
- **French and Italian** write the typographic apostrophe `’`. French puts a no-break space (U+00A0) before `?` and `:`.
- **Japanese and Chinese** put a space between their own text and a Latin name (`{name} を一時停止しました`,
  `已暂停 {name}`), none beside full-width punctuation and none beside a number (`{count}個のファイル`,
  `{count}个文件`). Korean and Turkish add no particle or suffix that changes with the name: `{name}에서`,
  `{name} adlı torrent`, and for a file's name `{name} dosyası` (`Watch {name}#a file`).
- **Short labels.** The footer's controls (Speed, On add, Storage, Auto-save) share one row and the list's column
  headers share the table's width, so each is a word or two where the language allows. Down and Up are the transfer's
  two directions below.
- **Plurals** carry every form the language needs (the check names a missing one): Russian and Polish
  `one, few, many, other`; Japanese, Korean and Chinese `other` alone; Arabic `zero, one, two, few, many, other`;
  Hebrew `one, two, other`. Arabic and Hebrew write one and two in words (`ملف واحد`, `ملفان`, `קובץ אחד`,
  `שני קבצים`), so their `one` and `two` branches hold no `{count}`. A count is written as the English writes it:
  `{count}` as given, never `#` or `{count, number}`, which group it (`1.100 Dateien`); the check names either form
  where the English lacks it.
- **A value Intl writes** (a size `1,5 Go`, a speed `512 ko/s`, a duration, a date) comes with its unit and in the
  nominative, so the words around it add no unit and ask no case of it: German `noch {eta}` where `in` would want a
  dative, Polish `jeszcze {eta}` where `za` would want an accusative, and a colon before a date. A unit written as
  text, the speed field's `kB/s`, is the unit as Intl writes it there (`ko/s`, `кБ/c`, `KB/秒`, `kB/sn`, `ك.ب/ث`,
  `kB/שנ׳`), so it reads as the speeds beside it. Arabic's units are Intl's narrow ones (`src/utils/bytes.ts`), whose
  short kilobyte is the whole word `كيلوبايت` beside `م.ب`. A piece size is binary, as qBittorrent writes it: `Kio` and `Mio` in French, `КБ` and `МБ` in
  Russian, `ك.ب` and `م.ب` in Arabic, `KiB` and `MiB` elsewhere, Hebrew too, whose sizes beside it Intl writes in Latin.
- **Arabic and Hebrew** read right to left, and `src/i18n` isolates each plain value at load, so a catalogue holds no
  direction mark. Brand names stay in Latin script, and a prefix joins one the way the language writes it: Arabic
  `لـ {name}` and `بـ {name}`, Hebrew `ב-{name}`, `ל-{name}` and `מ-{name}`. Arabic writes its own comma and question
  mark (`،`, `؟`) and guillemets (`«غير محدود»`), Hebrew gershayim (`״ללא הגבלה״`). A value beside an adjective or a past
  verb would ask it to agree with a number or a person nobody knows, so the line is a label and a colon, or Arabic's
  `تمت` with a verbal noun: `المتصلون: {count}`, `נבחרו: {count}`, `تمت الإضافة إلى {name}`,
  `הוספה לקבוצה: {name}`. A `.torrent` or `.zip` written beside a value or a word would be
  split from it by the isolate, so it is the language's words for the file: `ملف التورنت`, `كملف zip`, `קובץ הטורנט`,
  `כקובץ zip`.

## Register and torrent terms

The words of each language's qBittorrent (`src/lang/qbittorrent_<lang>.ts` in its repo, finished translations only, `es`
for `es-419`), so a ripple user reads what they expect. This table decides: the notes under it name each cell that
differs from qBittorrent, and why. The options menu's names (Force recheck, Download in sequential order, Super seeding
mode and the like) have no column here and follow that language's qBittorrent the same way.

| | register | torrent | magnet link | seeder, leecher | peer | tracker | piece |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `es-419` | tú, infinitive on buttons | torrent | enlace magnet | semilla, leecher | par | tracker | pieza |
| `pt-BR` | você, infinitive on buttons | torrent | link magnético | semeador, leecher | par | rastreador | pedaço |
| `fr` | vous, infinitive on buttons | torrent | lien magnet | source complète, source partielle | pair | tracker | morceau |
| `de` | du, infinitive on buttons | Torrent | Magnet-Link | Seeder, Leecher | Peer | Tracker | Teil |
| `it` | tu | torrent | collegamento magnet | sorgente, sorgente parziale | peer | tracker | parte |
| `ru` | вы | торрент | магнит-ссылка | сид, лич | пир | трекер | часть |
| `ja` | です・ます where a sentence is needed | Torrent | マグネットリンク | シーダー, リーチャー | ピア | トラッカー | ピース |
| `ko` | 해요체 where a sentence is needed | 토렌트 | 마그넷 링크 | 배포자, 공유자 | 피어 | 트래커 | 조각 |
| `zh-Hans` | 你 | torrent | 磁力链接 | 做种者, 下载者 | 用户 | Tracker | 区块 |
| `zh-Hant` | 你 | torrent | 磁力連結 | 種子, 下載者 | 用戶 | 追蹤者 | 分塊 |
| `tr` | siz | torrent | magnet bağlantısı | gönderen, çeken | kişi | izleyici | parça |
| `pl` | ty, or impersonal | torrent | odnośnik magnet | seedujący, pijawka | partner | tracker | część |
| `ar` | imperative in the masculine singular in a sentence, the verbal noun on buttons | تورنت | رابط مغناطيسي | باذر, محمِّل | قرين | متتبع | قطعة |
| `he` | imperative in the plural in a sentence, the action noun on buttons | טורנט | קישור מגנט | זורע, עלוקה | עמית | עוקבן | חתיכה |

Where this differs from qBittorrent:

- `es-419` leecher: qBittorrent's `Pares` is its word for a peer.
- `it` peer: qBittorrent mostly writes `Nodi`, its word for a DHT node too, and sometimes `Peer`.
- `zh-Hans` seeder and leecher: qBittorrent's `做种` and `下载` are column titles, and `下载` alone reads as a download.
- `zh-Hant` peer: qBittorrent's `下載者` is its word for a leecher too, and ripple shows both, so it takes the word
  `zh-Hans` uses. Never `節點` or `节点`, which is a DHT node.
- `ar` Paused is `متوقف مؤقتًا`, where qBittorrent's `مُلبث` is a word few readers know; a torrent's states read
  `قيد التنزيل`, `قيد البذر`, `قيد الفحص`. `he` Trackers is `עוקבנים`, where stub's `כלי מעקב` is a watch list's.
- The options menu's names: `Download first and last pieces first` takes this table's piece where qBittorrent's
  differs (`es-419` `piezas`, `it` `parte`, `zh-Hans` `区块`, `zh-Hant` `分塊`), and `pt-BR` writes `para` for its `pra`.
  Unlimited is a box's label and a value both, so `pl` writes `Bez limitu` for `Nieograniczone` and `zh-Hans` `无限制`
  for `无限制的`.

In Chinese `种子` and `種子` are a seed and never a torrent, which stays `torrent` as qBittorrent writes it.

A transfer's two directions, on a stat or a limit, are qBittorrent's too: `es-419` Bajada, Subida; `pt-BR`, `de` and `it`
Download, Upload; `fr` Réception, Envoi; `ru` Загрузка, Отдача; `ja` ダウンロード, アップロード; `ko` 다운로드, 업로드;
`zh-Hans` 下载, 上传; `zh-Hant` 下載, 上傳; `tr` İndirme, Gönderme; `pl` Pobieranie, Wysyłanie; `ar` التنزيل, الرفع;
`he` הורדה, העלאה.

## Ripple's own words

The library is the list of torrents ripple keeps. A share link opens one torrent on somebody else's device. A temporary
download is one the library does not keep. A group is a named set of torrents in the library, never the folder a
download is saved in.

| | library | share link | temporary download | group |
| --- | --- | --- | --- | --- |
| `es-419` | biblioteca | enlace para compartir | descarga temporal | grupo |
| `pt-BR` | biblioteca | link de compartilhamento | download temporário | grupo |
| `fr` | bibliothèque | lien de partage | téléchargement temporaire | groupe |
| `de` | Bibliothek | Freigabelink | temporärer Download | Gruppe |
| `it` | libreria | link di condivisione | download temporaneo | gruppo |
| `ru` | библиотека | ссылка для общего доступа | временная загрузка | группа |
| `ja` | ライブラリ | 共有リンク | 一時的なダウンロード | グループ |
| `ko` | 라이브러리 | 공유 링크 | 임시 다운로드 | 그룹 |
| `zh-Hans` | 资料库 | 分享链接 | 临时下载 | 分组 |
| `zh-Hant` | 資料庫 | 分享連結 | 暫時下載 | 分組 |
| `tr` | kütüphane | paylaşım bağlantısı | geçici indirme | grup |
| `pl` | biblioteka | link do udostępniania | tymczasowe pobieranie | grupa |
| `ar` | المكتبة | رابط مشاركة | تنزيل مؤقت | مجموعة |
| `he` | ספרייה | קישור שיתוף | הורדה זמנית | קבוצה |

## The VPN switch

The VPN takes an article where the language has one: `la VPN` in `es-419` and `it`, `a VPN` in `pt-BR`, `le VPN` in
`fr`, `das VPN` in `de`. Its state is one word on the switch (On, Off, Reconnecting, Unreachable, Waiting), and the
switch keeps the room of the widest of them, so a new or changed one is no wider than the widest that language has.
Off there is the state, and `Turn off` the action that leads to it (`Désactivé` and `Désactiver`, `Aus` and
`Ausschalten`). The state agrees with the VPN where it has a gender (`Desactivada`, `Desativada`, `Disattivata`,
`Désactivé`), and takes the VPN as masculine in Arabic and Hebrew (`يعمل`, `متوقف`, `פועל`, `כבוי`). `Turn off` stands beside Cancel in the warning, so it is never the catalogue's word for Close: where
the two would be one word it names the VPN (`VPN'i kapat`, `关闭 VPN`, `關閉 VPN`). A peer and a tracker in the
warning and in the line of a download that found nobody are the table's words above.
