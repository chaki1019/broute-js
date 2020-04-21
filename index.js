import SerialPort from 'serialport'
import dayjs from 'dayjs'
import 'dayjs/locale/ja.js'

/** 利用者情報 */
const config = {
    // Bルート認証ID
    id: '00000099021300000000000000C67BE0',
    // Bルート認証パスワード
    pass: 'FHUR7A2SME9A',
    // USBドングルデバイス
    device: '/dev/ttyUSB0'
}

const port = new SerialPort(config.device, {
    baudRate: 115200,
});

/** イベントハンドラ */
port.once('open', async () => {
    try {
        // エコーバック不要設定(レジスタを0にセット)
        await send(SENDMSG('SKSREG SFE 0'))
        
        // Bルート認証パスワード設定
        await send(SENDMSG('SKSETPWD C ' + config.pass))
        
        // Bルート認証ID設定
        await send(SENDMSG('SKSETRBID ' + config.id))
        
        // デバイススキャン(2はアクティブスキャン, 6は間隔)
        const device = await send(SENDMSG('SKSCAN 2 FFFFFFFF 6'), scanCallback)
        
        // Channel設定
        await send(SENDMSG('SKSREG S2 ' + device['Channel']))
        
        // Pan ID設定
        await send(SENDMSG('SKSREG S3 ' + device['Pan ID']))
        
        // MACアドレス->IPv6アドレス変換
        const ipv6Addr = (await send(SENDMSG('SKLL64 ' + device['Addr']))).trim()
        
        // PANA接続シーケンス開始
        await send(SENDMSG('SKJOIN ' + ipv6Addr), panaCallback)
        
        // 積算履歴収集日をセット(1日前)
        await send(SKSENDTO_SENDMSG(ipv6Addr, [
            0x10, 0x81,         // EHD
            0x00, 0x01,         // TID
            0x05, 0xFF, 0x01,   // SEOJ
            0x02, 0x88, 0x01,   // DEOJ
            0x61,               // ESV
            0x01,               // OPC
            0xE5,               // EPC
            0x01,               // PDC
            0x02                // EDT
        ]), erxudpCallback)

        // 単位 読み出し
        const E1buf = await send(SKSENDTO_SENDMSG(ipv6Addr, [
            0x10, 0x81,         // EHD
            0x00, 0x01,         // TID
            0x05, 0xFF, 0x01,   // SEOJ
            0x02, 0x88, 0x01,   // DEOJ
            0x62,               // ESV
            0x01,               // OPC
            0xE1,               // EPC
            0x00,               // PDC
        ]), erxudpCallback)
        const unit = setUnit(new DataView(E1buf.buffer).getUint8())

        // 係数 読み出し
        const D3buf = await send(SKSENDTO_SENDMSG(ipv6Addr, [
            0x10, 0x81,         // EHD
            0x00, 0x01,         // TID
            0x05, 0xFF, 0x01,   // SEOJ
            0x02, 0x88, 0x01,   // DEOJ
            0x62,               // ESV
            0x01,               // OPC
            0xD3,               // EPC
            0x00,               // PDC
        ]), erxudpCallback)
        const coefficient = new DataView(D3buf.buffer).getUint32()

        // 積算電力量計測値履歴1 読み出し
        const E2buf = await send(SKSENDTO_SENDMSG(ipv6Addr, [
            0x10, 0x81,         // EHD
            0x00, 0x01,         // TID
            0x05, 0xFF, 0x01,   // SEOJ
            0x02, 0x88, 0x01,   // DEOJ
            0x62,               // ESV
            0x01,               // OPC
            0xE2,               // EPC
            0x00,               // PDC
        ]), erxudpCallback)
        const dvE2 = new DataView(E2buf.buffer)
        const pastDay = dvE2.getUint16() // 0は当日、1～99日前まで

        /** アウトプット処理 */
        const outputArray = []
        const day = dayjs().add(pastDay * -1, 'day').set('hour', 0).set('minute', 0)
        for (let i = 2, min = 0; i < dvE2.byteLength; i += 4, min += 30) {
            const power = dvE2.getInt32(i)
            outputArray.push({
                datetime: day.add(min, 'minute'),
                totalPower: Math.round((power * coefficient * unit) * 10) / 10
            })
        }

        for (let i = outputArray.length - 1; i >= 0; i--) {
            const thisMinute = outputArray[i]
            let diffPower = '---'
            if (i < outputArray.length - 1) {
                diffPower = Math.round((outputArray[i + 1].totalPower - outputArray[i].totalPower) * 10) / 10
            }
            console.log(outputArray[i].datetime.format('YYYY/MM/DD HH:mm') + ' : ' + diffPower + ' kWh')
        }
    } catch (err) {
        console.error(err)
    } finally {
        try {
            // 切断
            await send(Buffer.from('SKTERM\r\n'), termCallback)
        } catch (err) {
            console.error(err)
        }
        port.close()
        process.exit()
    }
})

process.on('SIGINT', function() {
    port.close()
    process.exit()
})

let responseText = ''
let callbackObject = {
    cbFunction: undefined,
    resolve: undefined,
    reject: undefined
}
port.on('data', (buf) => {
    const res = buf.toString('utf8')
    responseText += res

    if (responseText.match(/\r\n$/)) {
        console.log(responseText)
        callbackObject.cbFunction(responseText, callbackObject.resolve, callbackObject.reject)
        responseText = '';
    }
})

/**
 * 電文送信関数
 * @param {*} _command 
 * @param {*} _callback 
 */
const send = (_command, _callback) => {
    return new Promise((resolve, reject) => {
        if (_callback && typeof _callback === 'function') {
            callbackObject.cbFunction = _callback
        } else {
            callbackObject.cbFunction = (_res, _resolve, _reject) => {
                _resolve(_res)
            }
        }
        callbackObject.resolve = resolve
        callbackObject.reject = reject

        port.write(_command, (err) => {
            if (err) {
                reject(err)
            }
        })
    })
}

/**
 * SKSCAN電文のレスポンス受信時コールバック関数
 * @param {*} res 
 * @param {*} resolve 
 * @param {*} reject 
 */
let device = null
const scanCallback = (res, resolve, reject) => {
    if (res.match(/(^|\r\n)EVENT 20/)) {
        device = {};
        res.split('\r\n').forEach((ln) => {
            var m = ln.match(/^\s+([^\:]+)\:(.+)/);
            if (m) {
                device[m[1]] = m[2];
            }
        });
    } else if (res.match(/(^|\r\n)EVENT 22/)) {
        if (device) {
            resolve(device)
        } else {
            setTimeout(async () => {
                port.write('SKSCAN 2 FFFFFFFF 6\r\n', 'utf8')
            }, 1000)
        }
    }
}

/**
 * SKJOIN電文のレスポンス受信時コールバック関数
 * @param {*} res 
 * @param {*} resolve 
 * @param {*} reject 
 */
let e25received = false
const panaCallback = (res, resolve, reject) => {
    if (res.match(/(^|\r\n)EVENT 24/)) {
        reject('PANA Connection Failed.')
    } else if (res.match(/(^|\r\n)EVENT 25/)) {
        e25received = true
    } else if (res.match(/(^|\r\n)ERXUDP/)) {
        if (e25received) {
            resolve(res)
        }
    }
}

/**
 * SKTERM電文のレスポンス受信時コールバック関数
 * @param {*} res 
 * @param {*} resolve 
 * @param {*} reject 
 */
const termCallback = (res, resolve, reject) => {
    if (res.match(/(^|\r\n)EVENT 27/)) {
        resolve()
    }
}

/**
 * SKSENDTO電文のレスポンス受信時コールバック関数
 * @param {*} res 
 * @param {*} resolve 
 * @param {*} reject 
 */
const erxudpCallback = (res, resolve, reject) => {
    try {
        if (res.match(/(^|\r\n)ERXUDP/)) {
            // ERXUDPから始まる電文の内、返送データ部を抽出し、文字列→16進数バッファ変換を行う
            const buf = ((parts) => {
                let part = null
                if (parts.length >= 10) {
                    part = parts[9]
                } else {
                    part = parts[8]
                }
                return Uint8Array.from(part.match(/.{1,2}/g).map(v => parseInt(v, 16)))
            })(res.trim().split(' '))
            const dv = new DataView(buf.slice(12).buffer)
            // EPC
            const EPC = dv.getUint8(0)
            // PDC
            const PDC = dv.getUint8(1)
            // EDT
            let EDT = null
            if (PDC > 0x00) {
                EDT = buf.slice(14, 14 + PDC)
            }
            resolve(EDT)
        }
    } catch (err) {
        reject(err)
    }
}

/**
 * 汎用メッセージを生成
 * @param {*} msg : 電文
 */
const SENDMSG = (msg) => {
    return Buffer.from(msg + '\r\n', 'utf8')
}

/**
 * SKSENDTOメッセージを生成
 * @param {*} addr : IPv6アドレス
 * @param {*} el : Echonet Liteフレーム電文
 */
const SKSENDTO_SENDMSG = (addr, el) => {
    const el_buf = Buffer.from(el)
    const byte_num_hex = ('000' + el_buf.length.toString(16)).slice(-4).toUpperCase()
    const cmd_base = 'SKSENDTO 1 ' + addr + ' 0E1A 2 ' + byte_num_hex + ' '
    const cmd_base_buf = Buffer.from(cmd_base)
    return Buffer.concat([cmd_base_buf, el_buf])
}

/**
 * 単位の値を変換する
 * @param {*} val : ERXUDP FE80:0000:0000:0000:C2F9:4500:4019:1875 FE80:0000:0000:0000:1207:23FF:FEA0:7523 0E1A 0E1A C0F9450040191875 1 000F 1081000102880105FF017201E10101
 *                  の末尾01部分
 */
const setUnit = (val) => {
    switch (val) {
        // 1 kWh
        case 0x00: return 1
        // 0.1 kWh
        case 0x01: return 0.1
        // 0.01 kWh
        case 0x02: return 0.01
        // 0.001 kWh
        case 0x03: return 0.001
        // 0.0001 kWh
        case 0x04: return 0.0001
        // 10 kWh
        case 0x0A: return 10
        // 100 kWh
        case 0x0B: return 100
        // 1000 kWh
        case 0x0C: return 1000
        // 10000 kWh
        case 0x0D: return 10000
        default : return null
    }
}
