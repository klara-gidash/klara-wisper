import { BrowserWindow } from 'electron'

/**
 * Decodes a compressed recording (webm/opus or mp4/AAC from the phone) to 16 kHz mono Int16 PCM
 * with Chromium's own decoder, in a hidden page that has no Node, no preload and no network: no
 * ffmpeg needed, the same on macOS and Windows. decodeAudioData resamples to the context's
 * rate, so a 16 kHz OfflineAudioContext hands back 16 kHz samples directly.
 */
const IN_CHUNK = 3 * 1024 * 1024 // bytes of input per call into the page
const OUT_CHUNK = 16000 * 60 // samples (one minute) per call out of the page

export async function decodeToPcm16k(bytes: Uint8Array): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, images: false, spellcheck: false }
  })
  // An empty page that runs only the code below; the app-wide handlers (index.ts) block navigation and new windows.
  try {
    await win.loadURL('about:blank')
    const wc = win.webContents
    await wc.executeJavaScript('window.__klaraIn = []; 0')
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < buf.length; i += IN_CHUNK) {
      const b64 = buf.subarray(i, i + IN_CHUNK).toString('base64')
      await wc.executeJavaScript(`window.__klaraIn.push(${JSON.stringify(b64)}); 0`)
    }
    const decoded: number | string = await wc.executeJavaScript(`(async () => {
      const parts = window.__klaraIn.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      window.__klaraIn = null
      const total = parts.reduce((n, p) => n + p.length, 0)
      const all = new Uint8Array(total)
      let o = 0
      for (const p of parts) { all.set(p, o); o += p.length }
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 16000 })
      let audio
      try {
        audio = await ctx.decodeAudioData(all.buffer)
      } catch (e) {
        return 'undecodable: ' + String((e && e.message) || e) // errors don't cross executeJavaScript well
      }
      const n = audio.length
      const out = new Int16Array(n)
      const channels = []
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
      for (let i = 0; i < n; i++) {
        let v = 0
        for (const ch of channels) v += ch[i]
        v /= channels.length || 1
        out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767)
      }
      window.__klaraOut = out
      return n
    })()`)
    if (typeof decoded === 'string') throw new Error(`EncodingError ${decoded}`)
    const samples = decoded
    const out = Buffer.alloc(samples * 2)
    for (let start = 0; start < samples; start += OUT_CHUNK) {
      const b64: string = await wc.executeJavaScript(`(() => {
        const s = window.__klaraOut.subarray(${start}, ${Math.min(samples, start + OUT_CHUNK)})
        const b = new Uint8Array(s.buffer, s.byteOffset, s.byteLength)
        let bin = ''
        for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
        return btoa(bin)
      })()`)
      Buffer.from(b64, 'base64').copy(out, start * 2)
    }
    return out
  } catch (err) {
    const msg = typeof err === 'object' && err && 'message' in err ? String((err as Error).message) : JSON.stringify(err)
    // decodeAudioData rejects with an EncodingError ("Unable to decode audio data") for a file it can't read.
    throw new Error(/EncodingError|Unable to decode audio/i.test(msg) ? 'the recording could not be decoded' : `decoding failed: ${msg.slice(0, 200)}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
