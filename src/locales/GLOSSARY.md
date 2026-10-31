# Translation glossary

Each `<tag>.json` here holds one language's text, keyed by the English message id (its English, plus `#description`
when two messages read alike). Whoever adds or changes an English string translates it into every catalogue in the
same change, using the terms below, and runs `npm run i18n:check`. The rules for every language are stub's
(`src/locales/GLOSSARY.md` there), so the two apps read alike.

## Every language

- **Never translated:** Ripple, FKN, Sintel, BitTorrent, qBittorrent, and the protocol names DHT, PeX, LSD and uTP.
- **A label stub already shows** takes stub's text as it stands, so the two apps read alike. The one exception is `ko`
  Remove, `제거` where stub writes `삭제`: ripple's `Remove and delete` needs both words.
- **No em or en dash** (U+2014, U+2013), even where the language's typography uses one: restructure, or use a comma,
  a colon, a plain hyphen or the language's own range mark (`～` in Japanese, `~` in Korean, `至` in Chinese).
- **French and Italian** write the typographic apostrophe `’`. French puts a no-break space (U+00A0) before `?` and `:`.
- **Japanese and Chinese** put a space between their own text and a Latin name (`{name} を一時停止しました`,
  `已暂停 {name}`), none beside full-width punctuation and none beside a number (`{count}個のファイル`,
  `{count}个文件`). Korean and Turkish add no particle or suffix that changes with the name: `{name}에서`,
  `{name} adlı torrent`.
- **Short labels.** The footer's controls (Speed, On add, Storage, Auto-save) share one row and the list's column
  headers share the table's width, so each is a word or two where the language allows.
- **Plurals** carry every form the language needs (the check names a missing one): Russian and Polish
  `one, few, many, other`; Japanese, Korean and Chinese `other` alone. A count is written as the English writes it:
  `{count}` as given, never `#` or `{count, number}`, which group it (`1.100 Dateien`); the check names either form
  where the English lacks it.
- **A value Intl writes** (a size `1,5 Go`, a speed `512 ko/s`, a duration, a date) comes with its unit and in the
  nominative, so the words around it add no unit and ask no case of it: German `noch {eta}` where `in` would want a
  dative, Polish `jeszcze {eta}` where `za` would want an accusative, and a colon before a date.

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

Where this differs from qBittorrent:

- `es-419` leecher: qBittorrent's `Pares` is its word for a peer.
- `it` peer: qBittorrent mostly writes `Nodi`, its word for a DHT node too, and sometimes `Peer`.
- `zh-Hans` seeder and leecher: qBittorrent's `做种` and `下载` are column titles, and `下载` alone reads as a download.
- `zh-Hant` peer: qBittorrent's `下載者` is its word for a leecher too, and ripple shows both, so it takes the word
  `zh-Hans` uses. Never `節點` or `节点`, which is a DHT node.

In Chinese `种子` and `種子` are a seed and never a torrent, which stays `torrent` as qBittorrent writes it.

A transfer's two directions, on a stat or a limit, are qBittorrent's too: `es-419` Bajada, Subida; `pt-BR`, `de` and `it`
Download, Upload; `fr` Réception, Envoi; `ru` Загрузка, Отдача; `ja` ダウンロード, アップロード; `ko` 다운로드, 업로드;
`zh-Hans` 下载, 上传; `zh-Hant` 下載, 上傳; `tr` İndirme, Gönderme; `pl` Pobieranie, Wysyłanie.

## Ripple's own words

The library is the list of torrents ripple keeps. A share link opens one torrent on somebody else's device. A temporary
download is one the library does not keep.

| | library | share link | temporary download |
| --- | --- | --- | --- |
| `es-419` | biblioteca | enlace para compartir | descarga temporal |
| `pt-BR` | biblioteca | link de compartilhamento | download temporário |
| `fr` | bibliothèque | lien de partage | téléchargement temporaire |
| `de` | Bibliothek | Freigabelink | temporärer Download |
| `it` | libreria | link di condivisione | download temporaneo |
| `ru` | библиотека | ссылка для общего доступа | временная загрузка |
| `ja` | ライブラリ | 共有リンク | 一時的なダウンロード |
| `ko` | 라이브러리 | 공유 링크 | 임시 다운로드 |
| `zh-Hans` | 资料库 | 分享链接 | 临时下载 |
| `zh-Hant` | 資料庫 | 分享連結 | 暫時下載 |
| `tr` | kütüphane | paylaşım bağlantısı | geçici indirme |
| `pl` | biblioteka | link do udostępniania | tymczasowe pobieranie |
