# Translation glossary

Each `<tag>.json` here holds one language's text, keyed by the English message id (its English, plus `#description`
when two messages read alike). Whoever adds or changes an English string translates it into every catalogue in the
same change, using the terms below, and runs `npm run i18n:check`. The rules for every language are stub's
(`src/locales/GLOSSARY.md` there), so the two apps read alike.

## Every language

- **Never translated:** Ripple, FKN, Sintel, BitTorrent, qBittorrent, and the protocol names DHT, PeX, LSD and uTP.
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

The words each language's own torrent clients use, qBittorrent's first, so a ripple user reads what they expect. The
options menu's names (Force recheck, Download in sequential order, Super seeding mode and the like) follow that
language's qBittorrent the same way.

| | register | torrent | magnet link | seeder, leecher | peer | tracker | piece |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `es-419` | tú, infinitive on buttons | torrent | enlace magnet | semilla, leecher | par | tracker | pieza |
| `pt-BR` | você, infinitive on buttons | torrent | link magnet | seeder, leecher | par | tracker | pedaço |
| `fr` | vous, infinitive on buttons | torrent | lien magnet | seeder, leecher | pair | tracker | morceau |
| `de` | du, infinitive on buttons | Torrent | Magnet-Link | Seeder, Leecher | Peer | Tracker | Teil |
| `it` | tu | torrent | link magnet | seeder, leecher | peer | tracker | parte |
| `ru` | вы | торрент | магнет-ссылка | сид, лич | пир | трекер | часть |
| `ja` | です・ます where a sentence is needed | トレント | マグネットリンク | シーダー, リーチャー | ピア | トラッカー | ピース |
| `ko` | 해요체 where a sentence is needed | 토렌트 | 마그넷 링크 | 시더, 리처 | 피어 | 트래커 | 조각 |
| `zh-Hans` | 你 | 种子 | 磁力链接 | 做种者, 下载者 | 节点 | Tracker | 区块 |
| `zh-Hant` | 你 | 種子 | 磁力連結 | 做種者, 下載者 | 節點 | Tracker | 區塊 |
| `tr` | siz | torrent | magnet bağlantısı | gönderen, çeken | eş | izleyici | parça |
| `pl` | ty, or impersonal | torrent | link magnet | seed, leech | peer | tracker | część |

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
