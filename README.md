# broute-js
Raspbian上のNode.js v12で動作します。

## 準備
* 電力会社から受け取ったBルートのIDとパスワード
* Wi-SUNに対応したUSBドングル (RL7023など)
* ソースコードをcloneして依存モジュールの追加
```
# git clone https://github.com/chaki1019/broute-js.git
# cd broute-js
# npm install
```
## 実行
コンソールで`node --experimental-modules index.js`と実行

## 結果
応答メッセージがつらつらと出力され、最後に2日前の24時間分30分ごとの消費電力が出力されます。

![broute-js](https://user-images.githubusercontent.com/5762369/79864103-d6ba4c80-8413-11ea-998e-522155e2f3b9.gif)
