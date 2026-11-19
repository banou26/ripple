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
  watch list. Stub's Stop is Hindi's `रोकें`, so Pause is `पॉज़ करें`. Paused takes qBittorrent's word where stub's reads as on hold (`ru` `На паузе`, `tr` `Duraklatıldı`,
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
- **Plurals** carry every form the language needs (the check names a missing one): Russian, Polish and Ukrainian
  `one, few, many, other`; Czech and Romanian `one, few, other`; Japanese, Korean, Chinese, Indonesian, Malay,
  Vietnamese and Thai `other` alone; Hindi `one, other`, its `one` taking 0 as well; Arabic
  `zero, one, two, few, many, other`; Hebrew `one, two, other`. Romanian puts `de` before a noun from 20 on
  (`20 de fișiere`), and Hungarian keeps the noun singular after a number (`5 fájl`). Arabic and Hebrew write one and two in words (`ملف واحد`, `ملفان`, `קובץ אחד`,
  `שני קבצים`), so their `one` and `two` branches hold no `{count}`. A count is written as the English writes it:
  `{count}` as given, never `#` or `{count, number}`, which group it (`1.100 Dateien`); the check names either form
  where the English lacks it.
- **A value Intl writes** (a size `1,5 Go`, a speed `512 ko/s`, a duration, a date) comes with its unit and in the
  nominative, so the words around it add no unit and ask no case of it: German `noch {eta}` where `in` would want a
  dative, Polish `jeszcze {eta}` where `za` would want an accusative, and a colon before a date. A unit written as
  text, the speed field's `kB/s`, is the unit as Intl writes it there (`ko/s`, `кБ/c`, `KB/秒`, `kB/sn`, `ك.ب/ث`,
  `kB/שנ׳`, `kB/sec`, `kB/δευτ.`, `kB/mp`, `kB/dtk`, `kB/giây`, `kB/วิ`, `kB/से॰`, `кБ/с`), so it reads as the speeds
  beside it. Arabic's units are Intl's narrow ones (`src/utils/bytes.ts`), whose
  short kilobyte is the whole word `كيلوبايت` beside `م.ب`. A piece size is binary, as qBittorrent writes it: `Kio` and `Mio` in French, `KiO` and `MiO` in
  Romanian, `КБ` and `МБ` in Russian, `КіБ` and `МіБ` in Ukrainian, `ك.ب` and `م.ب` in Arabic, `KiB` and `MiB`
  elsewhere, Hebrew, Hindi and Thai too, whose sizes beside it Intl writes in Latin.
- **Arabic and Hebrew** read right to left, and `src/i18n` isolates each plain value at load, so a catalogue holds no
  direction mark. Brand names stay in Latin script, and a prefix joins one the way the language writes it: Arabic
  `لـ {name}` and `بـ {name}`, Hebrew `ב-{name}`, `ל-{name}` and `מ-{name}`. Arabic writes its own comma and question
  mark (`،`, `؟`) and guillemets (`«غير محدود»`), Hebrew gershayim (`״ללא הגבלה״`). A value beside an adjective or a past
  verb would ask it to agree with a number or a person nobody knows, so the line is a label and a colon, or Arabic's
  `تمت` with a verbal noun: `المتصلون: {count}`, `נבחרו: {count}`, `تمت الإضافة إلى {name}`,
  `הוספה לקבוצה: {name}`. A `.torrent` or `.zip` written beside a value or a word would be
  split from it by the isolate, so it is the language's words for the file: `ملف التورنت`, `كملف zip`, `קובץ הטורנט`,
  `כקובץ zip`.
- **The second wave** follows stub's rules for it. A value takes no case ending: Hungarian writes it after a colon or
  in parentheses (`Másolva: {name}`, `A mentés nem sikerült ({name})`), since a suffix would follow the value's own
  vowels. A participle beside a count would agree with a gender the count does not give in Czech and Romanian, so
  their line is a label and a colon (`Připojeno: {count}`, `Conectați: {count}`). Thai ends a sentence with no full
  stop, asks with `ไหม` and no question mark, and parts clauses with a space; Hindi ends one with `।`, Greek asks
  with `;`. Ukrainian writes the apostrophe `’`, Romanian the comma-below `ș` and `ț`. Indonesian and Malay share
  words, not a vocabulary (`Unduh` and `Muat turun`, `Pengaturan` and `Tetapan`). Hindi writes a technical word as
  English says it, as stub's Hindi does (`स्पीड`, `सीडर`, `पीस`).

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
| `id` | Anda, the verb's base form on buttons | torrent | tautan magnet | benih, lintah | rekanan | pelacak | bagian |
| `vi` | bạn | torrent | liên kết magnet | máy chia sẻ, người leech | máy ngang hàng | máy theo dõi | mảnh |
| `th` | polite, a pronoun (คุณ) only where needed | ทอร์เรนต์ | ลิงก์แม็กเน็ต | ผู้ส่ง, ผู้รับ | เพียร์ | แทร็กเกอร์ | ชิ้นส่วน |
| `hi` | आप, the polite imperative (-ें) on buttons | टॉरेंट | मैग्नेट लिंक | सीडर, लीचर | पीयर | ट्रैकर | पीस |
| `uk` | ви | торрент | magnet-посилання | сід, лічер | пір | трекер | частина |
| `nl` | je, infinitive on buttons | torrent | magneetkoppeling | seeder, leecher | peer | tracker | deeltje |
| `sv` | du, imperative on buttons | torrent | magnetlänk | seeder, leecher | jämlike | spårare | del |
| `cs` | vy, infinitive on buttons | torrent | magnet odkaz | seeder, leecher | peer | tracker | část |
| `el` | εσείς, the action noun on buttons | torrent | σύνδεσμος magnet | διαμοιραστής, leecher | peer | tracker | κομμάτι |
| `ro` | dumneavoastră, the polite imperative on buttons | torrent | legătură magnet | sursă, lipitoare | partener | urmăritor | bucată |
| `hu` | te, the action noun on buttons | torrent | magnetlink | seeder, leecher | peer | tracker | szelet |
| `ms` | anda, the verb's base form on buttons | torrent | pautan magnet | penyemai, penyedut | rakan | penjejak | cebisan |

Where this differs from qBittorrent:

- `es-419` leecher: qBittorrent's `Pares` is its word for a peer.
- `it` peer: qBittorrent mostly writes `Nodi`, its word for a DHT node too, and sometimes `Peer`.
- `zh-Hans` seeder and leecher: qBittorrent's `做种` and `下载` are column titles, and `下载` alone reads as a download.
- `zh-Hant` peer: qBittorrent's `下載者` is its word for a leecher too, and ripple shows both, so it takes the word
  `zh-Hans` uses. Never `節點` or `节点`, which is a DHT node.
- `ar` Paused is `متوقف مؤقتًا`, where qBittorrent's `مُلبث` is a word few readers know; a torrent's states read
  `قيد التنزيل`, `قيد البذر`, `قيد الفحص`. `he` Trackers is `עוקבנים`, where stub's `כלי מעקב` is a watch list's,
  and so are `vi` `Máy theo dõi`, `th` `แทร็กเกอร์`, `sv` `Spårare` and `ro` `Urmăritoare` for stub's
  `Trình theo dõi`, `ตัวติดตาม`, `Trackers` and `Trackere`.
- `cs` Seeds is `Seedy`, `vi` `Máy chia sẻ` and `ms` `Penyemai`, where qBittorrent's `Zdroje`, `Chia sẻ` and
  `Semaian` read as the create dialog's Source (`Zdroj`), a share and a sowing.
- `hi` seeder, leecher, peer and piece are written as English says them (`सीडर`, `लीचर`, `पीयर`, `पीस`), where
  qBittorrent's `स्रोतस्वामी`, `जोंके`, `सहकर्मीं` and `टुकड़ा` read as an owner, leeches, a colleague and a scrap.
  Paused is stub's `रुका हुआ`, and `id` Paused `Dijeda`, where qBittorrent's `Ditangguhkan` reads as postponed.
- `ro` torrent is `torrent`, where qBittorrent's `torent` is a mountain stream; Paused is stub's `În pauză`.
- `sv` seeder and leecher are `seeder` and `leecher`, as Swedish torrent users write them, where qBittorrent's
  `distributör` leaves a tracker's URL no room in the details panel on a phone and `reciprokör` is a word few readers
  know; seeding keeps its `distribuerar`. `th` magnet link is `ลิงก์แม็กเน็ต` for qBittorrent's English `Magnet link`.
- `uk` Up is `Віддача`, as Russian's `Отдача`, and Down `Прийом` in a column, where qBittorrent's `Відвантаження` and
  `Завантаження` leave a peer's address no room in the details panel on a phone; `el` Client keeps qBittorrent's
  `Client`, as `Πρόγραμμα-πελάτης` is cut there.
- The options menu's names: `Download first and last pieces first` takes this table's piece where qBittorrent's
  differs (`es-419` `piezas`, `it` `parte`, `zh-Hans` `区块`, `zh-Hant` `分塊`), and `pt-BR` writes `para` for its `pra`.
  Unlimited is a box's label and a value both, so `pl` writes `Bez limitu` for `Nieograniczone` and `zh-Hans` `无限制`
  for `无限制的`.

In Chinese `种子` and `種子` are a seed and never a torrent, which stays `torrent` as qBittorrent writes it.

A transfer's two directions, on a stat or a limit, are qBittorrent's too: `es-419` Bajada, Subida; `pt-BR`, `de` and `it`
Download, Upload; `fr` Réception, Envoi; `ru` Загрузка, Отдача; `ja` ダウンロード, アップロード; `ko` 다운로드, 업로드;
`zh-Hans` 下载, 上传; `zh-Hant` 下載, 上傳; `tr` İndirme, Gönderme; `pl` Pobieranie, Wysyłanie; `ar` التنزيل, الرفع;
`he` הורדה, העלאה; `id` Unduh, Unggah; `vi` Tải xuống, Tải lên; `th` ดาวน์โหลด, อัปโหลด; `hi` डाउनलोड, अपलोड;
`uk` Завантаження (`Прийом` in a column), Віддача; `nl` Download, Upload; `sv` Hämtning, Sändning; `cs` Stahování, Odesílání;
`el` Λήψη, Αποστολή; `ro` Descărcare, Încărcare; `hu` Letöltés, Feltöltés; `ms` Muat turun, Muat naik.

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
| `id` | pustaka | tautan berbagi | unduhan sementara | grup |
| `vi` | thư viện | liên kết chia sẻ | bản tải tạm thời | nhóm |
| `th` | คลัง | ลิงก์แชร์ | การดาวน์โหลดชั่วคราว | กลุ่ม |
| `hi` | लाइब्रेरी | शेयर लिंक | अस्थायी डाउनलोड | ग्रुप |
| `uk` | бібліотека | посилання для спільного доступу | тимчасове завантаження | група |
| `nl` | bibliotheek | deellink | tijdelijke download | groep |
| `sv` | bibliotek | delningslänk | tillfällig hämtning | grupp |
| `cs` | knihovna | odkaz ke sdílení | dočasné stahování | skupina |
| `el` | βιβλιοθήκη | σύνδεσμος κοινοποίησης | προσωρινή λήψη | ομάδα |
| `ro` | bibliotecă | link de partajare | descărcare temporară | grup |
| `hu` | könyvtár | megosztási link | ideiglenes letöltés | csoport |
| `ms` | pustaka | pautan kongsi | muat turun sementara | kumpulan |

## The VPN switch

The VPN takes an article where the language has one: `la VPN` in `es-419` and `it`, `a VPN` in `pt-BR`, `le VPN` in
`fr`, `das VPN` in `de`. Its state is one word on the switch (On, Off, Reconnecting, Unreachable, Waiting), and the
switch keeps the room of the widest of them, so a new or changed one is no wider than the widest that language has.
Off there is the state, and `Turn off` the action that leads to it (`Désactivé` and `Désactiver`, `Aus` and
`Ausschalten`). The state agrees with the VPN where it has a gender (`Desactivada`, `Desativada`, `Disattivata`,
`Désactivé`), and takes the VPN as masculine in Arabic and Hebrew (`يعمل`, `متوقف`, `פועל`, `כבוי`) and as neuter
in Czech, Greek and Romanian (`Zapnuto`, `Ενεργό`, `Pornit`). `Turn off` stands beside Cancel in the warning, so it is never the catalogue's word for Close: where
the two would be one word it names the VPN (`VPN'i kapat`, `关闭 VPN`, `關閉 VPN`, `VPN बंद करें`, `ปิด VPN`). A peer and a tracker in the
warning and in the line of a download that found nobody are the table's words above.
