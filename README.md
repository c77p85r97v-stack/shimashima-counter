# シマシマカウンター

平積み資材（合板など）の側面を撮影して、枚数を数えるスマホ向けウェブアプリ。

- 公開URL: https://shimashima-counter.vercel.app
- 静的ファイルのみ（ビルド不要）。`engine.js` が計数エンジン、`worker.js` で解析、`app.js` が画面。
- 版を上げるときは `app.js` と `sw.js` の `VERSION` を両方変える。
