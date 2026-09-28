# Changelog

This is the release history that used to live in `manifest.json`'s `description` field.
The manifest now carries a single line, because Chrome documents that field as short text
(the Web Store caps it at 132 characters) and the extension itself is loaded unpacked, so
nobody ever read the history from there anyway.

Every entry below is the original prose, verbatim — only the headings and blank lines are new.

## 0.3.0 – 0.3.5 (initial feature set)

Records gomoku.com move order from the game socket, identifies the RIF opening, runs the Rapfi engine offscreen (multi-threaded or single-threaded fallback, global or stepwise), archives every game and replays it in the built-in viewer.

## 0.3.6

0.3.6 ships in 8 languages (zh-CN / zh-TW / ja / ko / en / ru / fr / de), switchable from a right-click menu on the toolbar icon or the viewer's settings page, and repaints the panel and the viewer the instant the setting changes. Stored identity values (tags, annotation labels, risk levels, opening codes) stay canonical so the learner keeps matching them by literal, and only their display is translated; error text travels from the offscreen engine as codes and is translated by whichever surface shows it. Adds a 📋 copy button to the panel header that puts the whole verdict on the clipboard as one line: model, both players, hand count, opening name and each side's AI rate. It also lets a board snapshot that arrives exactly one move ahead of the socket confirm that stone when its own event lands late, so a hand the server did report no longer counts as having no order.

## 0.3.7

0.3.7 makes game-end detection independent of any single page signal: it snapshots the board when a game ends, when a draw is declared, when the player starts a new game, and when the board is cleared or rebuilt, so a game that stopped mid-way is still archived and is never overwritten by the next one; the settlement wording (rematch / draw) is read as a fallback trigger too. It defaults the thread count to half the available cores (a 32-thread host defaults to 16, up from the old cap of 8), and ranks a four-three kill above a live four when deciding that the game is decided, so a losing side that opens a live four no longer ends the analysis early.

## 0.4.0

0.4.0 checks for its own updates over the network: because the extension is loaded unpacked from GitHub rather than installed from the Chrome Web Store, requestUpdateCheck() can never see a new release, so the latest version is read from a version.json in the repository root, compared segment by segment, re-checked at most every 12 hours on startup and on demand from a button in the settings page, and announced with a flow-layout banner at the top of the panel and under the viewer's navigation bar — a banner that pushes the UI down instead of covering it and can be dismissed for that one version for seven days. It also regroups the settings page into labelled sections on a multi-column auto-fill grid (1 column on a narrow window, 3-4 on a wide one) with the archive and sample statistics as side-by-side cards, and softens the white-side row in the four step tables from #f5f5f5 to #DCDCDC so a long review no longer glares.

## 0.4.1

*(Not migrated from the old description — the entries above are the verbatim manifest history; this one is written for the changelog. The same text is shipped to installed copies through `version.json`'s `releaseNotes`.)*

0.4.1 makes a captured game survive a hostile socket. A repeated coordinate used to cut the record short — the loop `break`ed, so a sixty-move game that replayed one position arrived as twelve moves and looked like an ordinary short game; repeats are now skipped with `continue` and counted in `meta.dropped`. Every timestamp is now an absolute `performance.now()` from the page's own clock (it used to be measured from a per-game origin that meant nothing outside the hook), with a `clockNow` field letting the collector verify the two JavaScript worlds really share a time base instead of assuming it — hands merged in from the board still carry no time at all, because a missing interval is better than an invented one. Archives are labelled with a data-quality verdict (good / partial / suspect) that is displayed and never fed into a score, and the viewer derives it for pre-0.4.1 archives too. Switching language repaints the interface immediately, including the fifteen step columns and the ▾ column menu, which used to stay in whatever language the page had loaded with. The analysis snapshot is taken once at job start so an archived board and its report can no longer disagree. And once the sample library grows 20% past the count the learner was last trained on, both the learning panel and the settings page say so.

